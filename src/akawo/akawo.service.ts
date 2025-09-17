/* eslint-disable no-case-declarations */
import {
  Injectable,
  BadRequestException,
  Logger,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Transaction } from './schemas/transaction.schema';
import Spitch from 'spitch';
import * as fs from 'fs/promises';
import axios from 'axios';
import * as path from 'path';
import * as os from 'os';
import ffmpeg = require('fluent-ffmpeg');
import { File } from 'node:buffer';
import {
  GoogleGenerativeAI,
  HarmCategory,
  HarmBlockThreshold,
} from '@google/generative-ai';

// Polyfill for the global File object, required by the Spitch SDK in Node.js < 20
if (typeof globalThis.File === 'undefined') {
  globalThis.File = File as any;
}

type ParsedTransaction = {
  customer: string;
  details: string;
  amount: number;
  type: 'debt' | 'income';
};
// At the top of the file
type Intent =
  | 'log_transaction'
  | 'query_debtors'
  | 'query_total_income'
  | 'query_total_debt'
  | 'unknown';

type SpitchVoice =
  | 'sade'
  | 'segun'
  | 'femi'
  | 'funmi'
  | 'amina'
  | 'aliyu'
  | 'hasan'
  | 'zainab'
  | 'john'
  | 'jude'
  | 'lina'
  | 'lucy'
  | 'henry'
  | 'kani'
  | 'ngozi'
  | 'amara'
  | 'obinna'
  | 'ebuka'
  | 'hana'
  | 'selam'
  | 'tena'
  | 'tesfaye';

@Injectable()
export class AkawoService {
  private spitch: Spitch;
  private readonly logger = new Logger(AkawoService.name);
  private genAI: GoogleGenerativeAI;
  private whisperApiUrl =
    'https://api-inference.huggingface.co/models/openai/whisper-large-v3';

  constructor(
    private configService: ConfigService,
    @InjectModel(Transaction.name) private transactionModel: Model<Transaction>,
  ) {
    const spitchApiKey = this.configService.get<string>('SPITCH_API_KEY');
    if (!spitchApiKey) {
      throw new Error(
        'SPITCH_API_KEY is not defined in environment variables.',
      );
    }
    this.spitch = new Spitch({ apiKey: spitchApiKey });

    const geminiApiKey = this.configService.get<string>('GEMINI_API_KEY');
    if (!geminiApiKey) {
      throw new Error(
        'GEMINI_API_KEY is not defined in environment variables.',
      );
    }
    this.genAI = new GoogleGenerativeAI(geminiApiKey);
  }

  async processAudioCommand(
    tempFilePath: string,
    userId: string,
    language: 'ig' | 'yo' | 'ha' | 'en' = 'en',
  ) {
    this.logger.log(`Processing audio file at path: ${tempFilePath}`);
    let transcribedText: string | null = null;

    try {
      transcribedText = await this.transcribeAudioWithWhisper(tempFilePath);

      // Clean up the original uploaded file immediately after transcription
      await fs.unlink(tempFilePath);
      this.logger.log(`Cleaned up temporary upload file: ${tempFilePath}`);

      if (!transcribedText) {
        throw new BadRequestException(
          'I could not understand the audio. Please speak clearly.',
        );
      }
      this.logger.log(`Gemini Transcribed Text: "${transcribedText}"`);

      const intent = await this.determineIntentWithLLM(transcribedText);
      this.logger.log(`Determined Intent (AI): "${intent}"`);

      switch (intent) {
        case 'log_transaction':
          return this.handleTransactionLogging(
            transcribedText,
            userId,
            language,
          );
        case 'query_debtors':
          return this.handleDebtorQuery(userId, language);
        case 'query_total_income':
          return this.handleCalculationQuery(
            transcribedText,
            userId,
            language,
            'income',
          );
        case 'query_total_debt':
          return this.handleCalculationQuery(
            transcribedText,
            userId,
            language,
            'debt',
          );
        default:
          const infoText = this.generateInfoMessage(language);
          const infoAudio = await this.generateSpeech(
            infoText,
            language,
            userId,
          );
          throw new BadRequestException({
            message: infoText,
            audioContent: infoAudio,
          });
      }
    } catch (error) {
      // FIX: Ensure cleanup happens only once, even on error.
      await fs
        .unlink(tempFilePath)
        .catch((e) =>
          this.logger.warn(
            `Could not clean up file on error (may already be deleted): ${tempFilePath}`,
          ),
        );
      this.logger.error('Error in main audio processing pipeline', error.stack);
      if (error instanceof BadRequestException) throw error;
      throw new InternalServerErrorException(
        'A server error occurred while processing your request.',
      );
    }
  }

  private async transcribeAudioWithWhisper(
    filePath: string,
  ): Promise<string | null> {
    this.logger.debug('Transcribing audio with Whisper on Hugging Face...');

    const hfApiKey = this.configService.get<string>('HUGGINGFACE_API_KEY');
    if (!hfApiKey) {
      this.logger.error('HUGGINGFACE_API_KEY is not configured.');
      throw new InternalServerErrorException(
        'Transcription service is not configured.',
      );
    }

    // Convert the input audio to a high-quality WAV format first
    const wavFilePath = await this.convertWebmToWav(filePath);

    try {
      const audioBuffer = await fs.readFile(wavFilePath);

      const response = await axios.post(this.whisperApiUrl, audioBuffer, {
        headers: {
          Authorization: `Bearer ${hfApiKey}`,
          'Content-Type': 'audio/wav',
          Accept: 'application/json',
        },
      });

      if (response.data && response.data.text) {
        const transcribedText = response.data.text.trim();
        this.logger.log(`Whisper Transcribed Text: "${transcribedText}"`);
        return transcribedText;
      }
      return null;
    } catch (error) {
      this.logger.error(
        'Error during Whisper transcription',
        error.response?.data || error.message,
      );
      return null;
    } finally {
      // Clean up the temporary WAV file
      await fs
        .unlink(wavFilePath)
        .catch((e) => this.logger.error('Failed to clean up WAV file', e));
    }
  }

  private convertWebmToWav(inputPath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const outputPath = path.join(os.tmpdir(), `output-${Date.now()}.wav`);
      ffmpeg(inputPath)
        .toFormat('wav')
        .audioCodec('pcm_s16le') // Standard uncompressed audio codec
        .audioBitrate('128k') // Good quality bitrate
        .audioChannels(1) // Mono audio for voice commands
        .audioFrequency(16000) // Optimal sample rate for speech recognition
        .on('error', (err) => {
          this.logger.error('FFmpeg error:', err.message);
          reject(
            new InternalServerErrorException('Failed to convert audio file.'),
          );
        })
        .on('end', () => {
          this.logger.log(
            `Successfully converted ${inputPath} to ${outputPath}`,
          );
          resolve(outputPath);
        })
        .save(outputPath);
    });
  }

  private async handleTransactionLogging(
    text: string,
    userId: string,
    language: 'ig' | 'yo' | 'ha' | 'en',
  ) {
    const parsedTransactions = await this.parseIntelligentV4(text);

    if (parsedTransactions.length === 0) {
      const errorText = this.generateErrorMessage(language);
      const errorAudio = await this.generateSpeech(errorText, language, userId);
      throw new BadRequestException({
        message: errorText,
        audioContent: errorAudio,
      });
    }

    const savedTransactions: (Transaction & { _id: any })[] = [];
    for (const txData of parsedTransactions) {
      const newTransaction = new this.transactionModel({
        ...txData,
        owner: userId,
      });
      const saved = await newTransaction.save();
      savedTransactions.push(saved.toObject());
    }

    const confirmationText = this.generateConfirmationMessageV2(
      savedTransactions,
      language,
    );
    const audioContent = await this.generateSpeech(
      confirmationText,
      language,
      userId,
    );

    return {
      type: 'transaction_logged',
      transactions: savedTransactions,
      audioContent,
      confirmationText,
    };
  }

  private async parseIntelligentV4(text: string): Promise<ParsedTransaction[]> {
    this.logger.debug(`V4 Parsing with LLM. Input text: "${text}"`);

    const safetySettings = [
      {
        category: HarmCategory.HARM_CATEGORY_HARASSMENT,
        threshold: HarmBlockThreshold.BLOCK_NONE,
      },
      {
        category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
        threshold: HarmBlockThreshold.BLOCK_NONE,
      },
      {
        category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
        threshold: HarmBlockThreshold.BLOCK_NONE,
      },
      {
        category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
        threshold: HarmBlockThreshold.BLOCK_NONE,
      },
    ];

    const model = this.genAI.getGenerativeModel({
      model: 'gemini-1.5-flash',
      safetySettings,
    });
    // in parseIntelligentV4 function

    // in parseIntelligentV4 function

    // in parseIntelligentV4 function

    const systemPrompt = `
You are Akawo, an expert financial assistant for a Nigerian market trader. Your single most important job is to listen to voice commands and convert them into perfectly structured JSON data with extreme precision. You must understand English, Yoruba, Igbo, and Hausa fluently.

### CORE DIRECTIVES
1.  **Output Format**: Your response MUST be a valid JSON array of objects. Each object MUST contain these keys: "customer", "details", "amount", "type" (either "income" or "debt").
2.  **No Hallucination**: NEVER invent information. If a monetary amount is not mentioned for a specific action, that action is NOT a valid financial transaction and must be ignored.
3.  **Empty Array on Failure**: If you analyze the text and find no valid, complete financial transactions, you MUST return an empty array: [].

### LOGIC & RULES
- **Multi-Transaction Sentences**: A single command can contain multiple transactions (e.g., a payment and a remaining debt). You must extract all of them.
- **Pronoun Resolution**: This is a critical rule. Pronouns like 'o', 'ó' (Yoruba), 'ọ' (Igbo), 'ya', 'ta' (Hausa), or 'he/she' (English) MUST refer to the most recently mentioned customer in the command. If a customer's name has been mentioned, do not default to "Oníbàárà" for subsequent actions by that person.
- **Customer Identification**: Prioritize finding a real customer name. ONLY use the default "Oníbàárà" if no name is mentioned anywhere in the command.
- **Details Extraction**: For the "details" field, be descriptive. Use the item mentioned (e.g., "shinkafa", "garri"). If an item was mentioned earlier for the same customer, use that as context for a remaining balance (e.g., "Remaining balance for shinkafa"). If no item is mentioned at all, use the default "Ọjà" (meaning 'goods').
- **Keyword Bank**:
    - **INCOME/PAID**: "san", "sanwo", "paid", "kwụrụ", "biya", "collected", "fun mi", "sells", "ta".
    - **DEBT/OWED**: "ku", "kú", "owes", "remaining", "ji", "karbi", "gba", "took", "bashi", "ụgwọ".
- **Number Conversion**: Accurately convert spoken numbers from all languages into digits (e.g., "ẹgbẹ̀rún méjì" -> 2000, "puku abụọ" -> 2000, "dubu biyu" -> 2000).

### THINKING PROCESS
Follow these steps to ensure accuracy:
1.  Break the user's command down into individual actions or clauses.
2.  Scan the entire command for any proper names to identify the primary customer(s).
3.  For each action, identify the item, the amount, and the type (income or debt) using the keyword bank.
4.  Link each action to a customer. If a pronoun is used, link it to the last customer identified.
5.  Strictly filter out any actions that are incomplete (e.g., a sale with no price).
6.  Construct the final JSON array from the valid, complete transactions.

### EXAMPLES

**--- English ---**
- **Input**: "Ada bought two bags of rice she paid 2,000 and is owing 100,000."
- **Output**: [{"customer":"Ada","details":"Sale of two bags of rice","amount":2000,"type":"income"},{"customer":"Ada","details":"Remaining balance from rice sale","amount":100000,"type":"debt"}]

**--- Yoruba (demonstrating pronoun rule) ---**
- **Input**: "Mo ta garri fun Femi, o san ẹgbẹ̀rún méjì, ó sì ku ẹgbẹ̀rún kan."
- **Output**: [{"customer":"Femi","details":"garri","amount":2000,"type":"income"},{"customer":"Femi","details":"Remaining balance for garri","amount":1000,"type":"debt"}]

**--- Igbo (demonstrating pronoun rule) ---**
- **Input**: "M rere akpụ nye Obi, ọ kwụrụ puku abụọ, ma jide puku atọ."
- **Output**: [{"customer":"Obi","details":"akpụ","amount":2000,"type":"income"},{"customer":"Obi","details":"Remaining balance for akpụ","amount":3000,"type":"debt"}]

**--- Hausa (demonstrating pronoun rule) ---**
- **Input**: "Na sayar da shinkafa ga Aisha, ta biya dubu biyu, kuma saura dubu daya."
- **Output**: [{"customer":"Aisha","details":"shinkafa","amount":2000,"type":"income"},{"customer":"Aisha","details":"Remaining balance for shinkafa","amount":1000,"type":"debt"}]

**--- Invalid Input (Missing Amount) ---**
- **Input**: "I sold three red palm oils to Emma"
- **Output**: []

**--- Unrelated Input ---**
- **Input**: "How is the market today?"
- **Output**: []
`;

    try {
      const result = await model.generateContent([systemPrompt, text]);
      const llmResponseText = result.response.text();
      this.logger.debug(`LLM Raw JSON Response: ${llmResponseText}`);
      const cleanedJson = llmResponseText
        .replace(/```json/g, '')
        .replace(/```/g, '')
        .trim();
      const parsedJson = JSON.parse(cleanedJson);

      if (Array.isArray(parsedJson)) {
        return parsedJson as ParsedTransaction[];
      }
      return [];
    } catch (error) {
      this.logger.error(
        'Error calling or parsing response from Gemini API for JSON extraction',
        error,
      );
      return [];
    }
  }

  // --- All other helper functions remain the same ---
  // ... (handleDebtorQuery, getTransactionsForUser, etc.)
  private async handleDebtorQuery(
    userId: string,
    language: 'ig' | 'yo' | 'ha' | 'en',
  ) {
    const transactions = await this.getTransactionsForUser(userId);
    const debtors = transactions.filter((t) => t.type === 'debt');

    const responseText =
      debtors.length > 0
        ? this.formatDebtorList(debtors, language)
        : this.generateNoDebtorsMessage(language);

    const audioContent = await this.generateSpeech(
      responseText,
      language,
      userId,
    );

    return {
      type: 'query_response',
      confirmationText: responseText,
      audioContent,
    };
  }

  async getTransactionsForUser(userId: string): Promise<Transaction[]> {
    return this.transactionModel
      .find({ owner: userId })
      .sort({ createdAt: -1 })
      .exec();
  }

  private getVoiceForLanguage(
    lang: 'ig' | 'yo' | 'ha' | 'en',
    userId: string,
  ): SpitchVoice {
    const voiceMap: Record<'yo' | 'ig' | 'ha' | 'en', SpitchVoice[]> = {
      yo: ['sade', 'segun', 'femi', 'funmi'],
      ig: ['ngozi', 'amara', 'obinna', 'ebuka'],
      ha: ['amina', 'aliyu', 'hasan', 'zainab'],
      en: ['john', 'jude', 'lina', 'lucy', 'henry'],
    };

    const voices = voiceMap[lang] || voiceMap.yo;

    let hash = 0;
    for (let i = 0; i < userId.length; i++) {
      hash = (hash << 5) - hash + userId.charCodeAt(i);
      hash |= 0;
    }

    const index = Math.abs(hash) % voices.length;
    return voices[index];
  }

  private normalizeTextForTTS(text: string): string {
    return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  private async generateSpeech(
    text: string,
    language: 'ig' | 'yo' | 'ha' | 'en',
    userId: string,
  ): Promise<string | null> {
    try {
      const voice = this.getVoiceForLanguage(language, userId);
      const sanitizedText = this.normalizeTextForTTS(text);

      const ttsResponse = await this.spitch.speech.generate({
        text: sanitizedText,
        language,
        voice,
      });
      return Buffer.from(await ttsResponse.arrayBuffer()).toString('base64');
    } catch (error) {
      this.logger.error(
        `Spitch TTS API failed for text: "${text}"`,
        error.stack,
      );
      return null;
    }
  }

  private formatDebtorList(debtors: Transaction[], lang: string): string {
    const intro = {
      yo: 'Àwọn tó jẹ́ ọ́ lówó nìyí: ',
      ig: 'Ndị ji gị ụgwọ bụ: ',
      ha: 'Ga waɗanda ke bin ka bashi: ',
      en: 'Here are the people who owe you money: ',
    };
    const list = debtors
      .map((d) => `${d.customer}, ₦${d.amount.toLocaleString()}`)
      .join('. ');
    return intro[lang] + list;
  }

  private generateNoDebtorsMessage(lang: string): string {
    const messages = {
      yo: 'Kò sí ẹnikẹ́ni tó jẹ́ ọ́ lówó.',
      ig: 'Onweghị onye ji gị ụgwọ.',
      ha: 'Babu wanda ke bin ka bashi.',
      en: 'You have no outstanding debts.',
    };
    return messages[lang];
  }

  private generateConfirmationMessageV2(
    transactions: (Transaction & { _id: any })[],
    lang: 'ig' | 'yo' | 'ha' | 'en',
  ): string {
    if (transactions.length === 0) return this.generateErrorMessage(lang);

    // If there's only one transaction, use the existing detailed message function
    if (transactions.length === 1) {
      return this.generateConfirmationMessage(
        transactions[0] as ParsedTransaction,
        lang,
      );
    }

    // Language-specific terms
    const terms = {
      yo: {
        debt: 'gbèsè',
        income: 'ìsanwó',
        and: 'àti',
        for: 'fún',
        preamble: 'O dáa. Mo ti kọ sílẹ̀:',
      },
      ig: {
        debt: 'ụgwọ',
        income: 'ịkwụ ụgwọ',
        and: 'na',
        for: 'maka',
        preamble: 'Ọ dị mma. Edeela m:',
      },
      ha: {
        debt: 'bashi',
        income: 'biya',
        and: 'da',
        for: 'don',
        preamble: 'Na gode. Na rubuta:',
      },
      en: {
        debt: 'a debt of',
        income: 'a payment of',
        and: 'and',
        for: 'for',
        preamble: "Got it. I've logged:",
      },
    };

    const selectedTerms = terms[lang];

    const summary = transactions
      .map(
        (tx) =>
          `${tx.type === 'debt' ? selectedTerms.debt : selectedTerms.income} ₦${tx.amount.toLocaleString()}`,
      )
      .join(` ${selectedTerms.and} `);

    const customer = transactions[0].customer;

    return `${selectedTerms.preamble} ${summary} ${selectedTerms.for} ${customer}.`;
  }

  private generateConfirmationMessage(
    data: ParsedTransaction,
    lang: string,
  ): string {
    const { customer, amount, type, details } = data;
    switch (lang) {
      case 'yo':
        return `O dáa. Mo ti kọ sílẹ̀ pé ${customer} ${
          type === 'debt' ? 'gbà' : 'san'
        } ₦${amount.toLocaleString()} fún ${details}.`;
      case 'ig':
        return `Ọ dị mma. Edeela m na ${customer} ${
          type === 'debt' ? 'ji' : 'kwụrụ'
        } ₦${amount.toLocaleString()} maka ${details}.`;
      case 'ha':
        return `Na gode. Na rubuta cewa ${customer} ya ${
          type === 'debt' ? 'karɓi' : 'biya'
        } ₦${amount.toLocaleString()} don ${details}.`;
      default:
        return `Got it. I've recorded that ${customer} ${
          type === 'debt' ? 'owes' : 'paid'
        } ₦${amount.toLocaleString()} for ${details}.`;
    }
  }

  private generateErrorMessage(lang: string): string {
    switch (lang) {
      case 'yo':
        return 'Ẹ jọ̀wọ́, n kò gbọ́ yé yín. Sọ orúkọ oníbàárà, iye owó, àti ìdí rẹ̀, tàbí béèrè ìbéèrè rẹ.';
      case 'ig':
        return 'Biko, aghọtaghị m. Gwa m onye ahịa, ego ole, na ihe kpatara ya, ma ọ bụ jụọ ajụjụ gị.';
      case 'ha':
        return 'Yi haƙuri, ban gane ba. Faɗi sunan abokin ciniki, nawa, da kuma dalili, ko yi tambayarka.';
      default:
        return 'Sorry, I did not understand. Please state the customer, amount, and reason, or ask your question.';
    }
  }

  // Add this new function inside the AkawoService class

  private async handleCalculationQuery(
    text: string,
    userId: string,
    language: 'ig' | 'yo' | 'ha' | 'en',
    type: 'income' | 'debt',
  ) {
    const transactions = await this.getTransactionsForUser(userId);

    // Check if a specific customer is mentioned in the query
    let customerName: string | null = null;
    const potentialCustomer = transactions.find((tx) =>
      text.toLowerCase().includes(tx.customer.toLowerCase()),
    );
    if (potentialCustomer) {
      customerName = potentialCustomer.customer;
    }

    const relevantTransactions = transactions.filter((t) => {
      const typeMatch = t.type === type;
      const customerMatch = !customerName || t.customer === customerName;
      return typeMatch && customerMatch;
    });

    const totalAmount = relevantTransactions.reduce(
      (sum, t) => sum + t.amount,
      0,
    );

    const responseText = this.generateCalculationResponse(
      totalAmount,
      type,
      language,
      customerName,
    );

    const audioContent = await this.generateSpeech(
      responseText,
      language,
      userId,
    );

    return {
      type: 'query_response',
      confirmationText: responseText,
      audioContent,
    };
  }

  // Add this new function as well

  private generateCalculationResponse(
    amount: number,
    type: 'income' | 'debt',
    lang: 'ig' | 'yo' | 'ha' | 'en',
    customerName?: string | null,
  ): string {
    const formattedAmount = `₦${amount.toLocaleString()}`;

    const messages = {
      yo: {
        income: customerName
          ? `Owó tó wọlé látọ̀dọ̀ ${customerName} jẹ́ ${formattedAmount}.`
          : `Pàápàá owó tó wọlé jẹ́ ${formattedAmount}.`,
        debt: customerName
          ? `Gbèsè tí ${customerName} jẹ́ ọ́ jẹ́ ${formattedAmount}.`
          : `Pàápàá gbèsè tí wọ́n jẹ́ ọ́ jẹ́ ${formattedAmount}.`,
      },
      ig: {
        income: customerName
          ? `Ego i nwetara n'aka ${customerName} bụ ${formattedAmount}.`
          : `Mgbakọta ego i nwetara bụ ${formattedAmount}.`,
        debt: customerName
          ? `Ụgwọ ${customerName} ji gị bụ ${formattedAmount}.`
          : `Mgbakọta ụgwọ a ji gị bụ ${formattedAmount}.`,
      },
      ha: {
        income: customerName
          ? `Kudin da ka samu daga ${customerName} shine ${formattedAmount}.`
          : `Jimlar kudin da ka samu shine ${formattedAmount}.`,
        debt: customerName
          ? `Bashin da ${customerName} ke bin ka shine ${formattedAmount}.`
          : `Jimlar bashin da ake bin ka shine ${formattedAmount}.`,
      },
      en: {
        income: customerName
          ? `Your total income from ${customerName} is ${formattedAmount}.`
          : `Your total income is ${formattedAmount}.`,
        debt: customerName
          ? `The total debt owed by ${customerName} is ${formattedAmount}.`
          : `Your total outstanding debt is ${formattedAmount}.`,
      },
    };

    return messages[lang][type];
  }

  // Add this new function inside the AkawoService class
  private async determineIntentWithLLM(text: string): Promise<Intent> {
    this.logger.debug(`Determining intent with LLM for: "${text}"`);
    const model = this.genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

    const systemPrompt = `
    You are an intent classifier. Your task is to analyze the user's text and determine their goal.
    You MUST respond with ONLY ONE of the following valid intent strings:
    - "log_transaction": If the user is stating a sale, payment, debt, or any financial record.
    - "query_debtors": If the user is asking WHO owes them money or for a list of debtors.
    - "query_total_income": If the user is asking for their TOTAL income.
    - "query_total_debt": If the user is asking for their TOTAL debt.
    - "unknown": If the intent is unclear or does not fit any of the above categories.

    Examples:
    - User text: "Ada paid 2000 for rice" -> "log_transaction"
    - User text: "Ta lo je mi lowo?" -> "query_debtors"
    - User text: "Show me the list of people owing me" -> "query_debtors"
    - User text: "Kí ni gbogbo owó tó wọlé?" -> "query_total_income"
    - User text: "What is my total debt?" -> "query_total_debt"
  `;

    try {
      const result = await model.generateContent([systemPrompt, text]);
      const intent = result.response.text().trim() as Intent;

      // Validate the response from the LLM
      const validIntents: Intent[] = [
        'log_transaction',
        'query_debtors',
        'query_total_income',
        'query_total_debt',
        'unknown',
      ];
      if (validIntents.includes(intent)) {
        return intent;
      }
      this.logger.warn(
        `LLM returned an invalid intent: "${intent}". Falling back to unknown.`,
      );
      return 'unknown';
    } catch (error) {
      this.logger.error('Error determining intent with LLM', error);
      return 'unknown'; // Fallback in case of an API error
    }
  }

  // Add this new function inside the AkawoService class

  private generateInfoMessage(lang: 'ig' | 'yo' | 'ha' | 'en'): string {
    const messages = {
      yo: 'Èmi ni Akawọ, olùrànlọ́wọ́ yín fún ìṣirò owó. Ẹ lè sọ fún mi nípa ọjà tẹ́ ẹ tà àti gbèsè, tàbí kí ẹ béèrè àwọn tó jẹ yín lówó àti gbogbo owó tó wọlé.',
      ig: 'Abụ m Akawo, onye enyemaka ego gị. Ị nwere ike ịgwa m gbasara ahịa na ụgwọ gị, ma ọ bụ jụọ m maka ndị ji gị ụgwọ na ego ole i nwetara.',
      ha: 'Ni ne Akawo, mataimakin ku na kuɗi. Kuna iya gaya mani game da tallace-tallace da basussuka, ko ku tambaye ni jerin sunayen masu bin ku bashi da jimlar kuɗin da aka samu.',
      en: 'I am Akawo, your personal finance assistant. You can tell me about your sales and debts, or ask me to list your debtors and total income or debt.',
    };
    return messages[lang];
  }
}
