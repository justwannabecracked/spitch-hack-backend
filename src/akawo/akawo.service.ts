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
import { NotFoundException } from '@nestjs/common';
import { startOfDay, endOfDay, parseISO } from 'date-fns';

if (typeof globalThis.File === 'undefined') {
  globalThis.File = File as any;
}

type ParsedTransaction = {
  customer: string;
  details: string;
  amount: number;
  type: 'debt' | 'income';
};
type Intent =
  | 'log_transaction'
  | 'query_debtors'
  | 'query_total_income'
  | 'query_total_debt'
  | 'ask_capabilities';

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
        case 'ask_capabilities':
        default:
          return this.handleCapabilitiesQuery(userId, language);
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

  async deleteSingleTransaction(
    transactionId: string,
    userId: string,
  ): Promise<{ message: string }> {
    this.logger.log(
      `Attempting to delete transaction ${transactionId} for user ${userId}`,
    );

    const result = await this.transactionModel.findOneAndDelete({
      _id: transactionId,
      owner: userId,
    });

    if (!result) {
      throw new NotFoundException(
        `Transaction with ID "${transactionId}" not found or you do not have permission to delete it.`,
      );
    }
    return { message: 'Transaction deleted successfully.' };
  }

  async deleteTransactionsByDate(
    dateString: string,
    userId: string,
  ): Promise<{ message: string; deletedCount: number }> {
    this.logger.log(
      `Attempting to delete all transactions on ${dateString} for user ${userId}`,
    );

    const day = parseISO(dateString);
    const startDate = startOfDay(day);
    const endDate = endOfDay(day);

    const result = await this.transactionModel.deleteMany({
      owner: userId,
      createdAt: {
        $gte: startDate,
        $lte: endDate,
      },
    });

    if (result.deletedCount === 0) {
      this.logger.warn(
        `No transactions found to delete on ${dateString} for user ${userId}`,
      );
    }

    return {
      message: `Successfully deleted all transactions for ${dateString}.`,
      deletedCount: result.deletedCount,
    };
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
        .audioCodec('pcm_s16le')
        .audioBitrate('128k')
        .audioChannels(1)
        .audioFrequency(16000)
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
    const systemPrompt = `
You are akawọ́, an expert financial assistant for a Nigerian market trader. Your single most important job is to listen to voice commands and convert them into perfectly structured JSON data with extreme precision. You must understand English, Yoruba, Igbo, and Hausa fluently.

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

  private async generateSpeech(
    text: string,
    language: 'ig' | 'yo' | 'ha' | 'en',
    userId: string,
  ): Promise<string | null> {
    try {
      const voice = this.getVoiceForLanguage(language, userId);

      const ttsResponse = await this.spitch.speech.generate({
        text: text,
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

    if (transactions.length === 1) {
      return this.generateConfirmationMessage(
        transactions[0] as ParsedTransaction,
        lang,
      );
    }

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
        preamble: "Alright. I've logged:",
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
        return `Alright. I've recorded that ${customer} ${
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

  private async handleCalculationQuery(
    text: string,
    userId: string,
    language: 'ig' | 'yo' | 'ha' | 'en',
    type: 'income' | 'debt',
  ) {
    const transactions = await this.getTransactionsForUser(userId);

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

  private async determineIntentWithLLM(text: string): Promise<Intent> {
    this.logger.debug(`Determining intent with LLM for: "${text}"`);
    const model = this.genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

    const systemPrompt = `
You are a highly precise intent classification AI for "Akawo," a voice assistant for Nigerian traders. Your task is to analyze transcribed user commands in English, Yoruba, Igbo, or Hausa and determine the user's primary goal.

### Your Instructions
1.  Your response MUST be ONLY ONE of the following intent strings: "log_transaction", "query_debtors", "query_total_income", "query_total_debt", or "ask_capabilities".
2.  Prioritize the main financial question or statement.

### Comprehensive Examples

---
**INTENT: log_transaction** (User is stating a complex sale with partial payment)
- User text: "I sold four fufu to Femi, he paid two thousand, five thousand is remaining" -> "log_transaction"
- User text: "Mota fufu merin fun Femi, o san ẹgbẹ̀rún méjì, ó ku ẹgbẹ̀rún márùn" -> "log_transaction"
- User text: "Aisha bought rice, she paid 10k and owes 5k" -> "log_transaction"
- User text: "Na sayar da shinkafa ga Obi, ya biya dubu biyu, saura dubu daya" -> "log_transaction"

---
**INTENT: query_debtors** (User is asking WHO owes them money)
- User text: "Show me the list of people who are owing me" -> "query_debtors"
- User text: "Ta lo je mi lowo?" -> "query_debtors"
- User text: "Kedu ndị ji m ụgwọ?" -> "query_debtors"
- User text: "Su wanene ke bina bashi?" -> "query_debtors"

---
**INTENT: query_total_income** (User is asking for their TOTAL income/credit)
- User text: "what is my total profit" -> "query_total_income"
- User text: "Kí ni gbogbo owó tó wọlé?" -> "query_total_income"
- User text: "Ego ole ka m nwetara na mkpokọta?" -> "query_total_income"
- User text: "Nawa ne jimlar kudin da na samu?" -> "query_total_income"

---
**INTENT: query_total_debt** (User is asking for their TOTAL outstanding debt)
- User text: "how much do people owe me in total" -> "query_total_debt"
- User text: "Èló ni gbogbo gbèsè tí wọ́n jẹ́ mi?" -> "query_total_debt"
- User text: "Mgbakọta ụgwọ ole ka a ji m?" -> "query_total_debt"
- User text: "Nawa ne jimlar bashin da ake bina?" -> "query_total_debt"

---
**INTENT: ask_capabilities** (The request is unrelated, a greeting, or a general question)
- User text: "how is the market today" -> "ask_capabilities"
- User text: "E kaasan" -> "ask_capabilities"
- User text: "what can you do for me?" -> "ask_capabilities"
- User text: "Na gode" -> "ask_capabilities"
  `;

    try {
      const result = await model.generateContent([systemPrompt, text]);
      const intent = result.response.text().trim() as Intent;
      const validIntents: Intent[] = [
        'log_transaction',
        'query_debtors',
        'query_total_income',
        'query_total_debt',
        'ask_capabilities',
      ];
      if (validIntents.includes(intent)) {
        return intent;
      }
      this.logger.warn(
        `LLM returned an invalid intent: "${intent}". Falling back.`,
      );
      return 'ask_capabilities';
    } catch (error) {
      this.logger.error('Error determining intent with LLM', error);
      return 'ask_capabilities';
    }
  }

  private async handleCapabilitiesQuery(
    userId: string,
    language: 'ig' | 'yo' | 'ha' | 'en',
  ) {
    const greetings = {
      en: 'Hello! I am akawọ́, your voice assistant for logging sales and tracking debts. How can I help you today?',
      yo: 'E ku asiko yi! Èmi ni akawọ́, olùrànlọ́wọ́ yín fún ìṣirò owó. Báwo ni mo ṣe lè ràn yín lọ́wọ́ lónìí?',
      ig: 'Ndeewo! Abụ m akawọ́, onye enyemaka gị maka idekọ ahịa na ụgwọ. Kedu ka m ga-esi nyere gị aka taa?',
      ha: 'Sannu! Ni ne akawọ́, mataimakin ka na murya don rubuta tallace-tallace da bin diddigin basusuka. Yaya zan iya taimaka maka a yau?',
    };

    const responseText = greetings[language];
    const audioContent = await this.generateSpeech(
      responseText,
      language,
      userId,
    );

    return {
      type: 'info_response',
      confirmationText: responseText,
      audioContent,
    };
  }

  private generateInfoMessage(lang: 'ig' | 'yo' | 'ha' | 'en'): string {
    const messages = {
      yo: 'Èmi ni akawọ́, olùrànlọ́wọ́ yín fún ìṣirò owó. Ẹ lè sọ fún mi nípa ọjà tẹ́ ẹ tà àti gbèsè, tàbí kí ẹ béèrè àwọn tó jẹ yín lówó àti gbogbo owó tó wọlé.',
      ig: 'Abụ m akawọ́, onye enyemaka ego gị. Ị nwere ike ịgwa m gbasara ahịa na ụgwọ gị, ma ọ bụ jụọ m maka ndị ji gị ụgwọ na ego ole i nwetara.',
      ha: 'Ni ne akawọ́, mataimakin ku na kuɗi. Kuna iya gaya mani game da tallace-tallace da basussuka, ko ku tambaye ni jerin sunayen masu bin ku bashi da jimlar kuɗin da aka samu.',
      en: 'I am akawọ́, your personal finance assistant. You can tell me about your sales and debts, or ask me to list your debtors and total income or debt.',
    };
    return messages[lang];
  }
}
