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
// Node.js built-in modules for handling files and paths
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

      const intent = this.determineIntent(transcribedText);
      this.logger.log(`Determined Intent: "${intent}"`);

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
          const errorText = this.generateErrorMessage(language);
          const errorAudio = await this.generateSpeech(
            errorText,
            language,
            userId,
          );
          throw new BadRequestException({
            message: errorText,
            audioContent: errorAudio,
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

    const systemPrompt = `
  You are an expert accounting assistant for a Nigerian market trader named Akawo.
  Your task is to analyze transcribed voice commands in Nigerian languages (English, Yoruba, Igbo, Hausa) and extract transaction details with extreme precision.

  Keywords for INCOME/PAID: "san", "sanwo", "paid", "kwụrụ", "biya", "collected", "fun mi".
  Keywords for DEBT/OWED: "ku", "kú", "owes", "remaining", "ji", "karbi", "gba", "took".

  RULES:
  - A single sentence can contain both an income and a debt transaction for the same person.
  - Your response MUST be a valid JSON array of objects with keys: "customer", "details", "amount", and "type" ("income" or "debt").
  - If no specific customer name is mentioned, use "Oníbàárà" as the customer.
  - If no specific details are mentioned, use "Ọjà" (meaning 'goods').
  - Accurately convert spoken numbers into digits (e.g., "ẹgbẹ̀rún méjì" -> 2000, "puku abụọ" -> 2000).
  - If no valid transaction can be extracted, you MUST return an empty array: [].

  EXAMPLES:
  - English Input: "Ada bought two bags of rice she paid 2,000 and is owing 100,000."
  - English Output: [{"customer":"Ada","details":"Sale of two bags of rice","amount":2000,"type":"income"},{"customer":"Ada","details":"Remaining balance from rice sale","amount":100000,"type":"debt"}]

  - Yoruba Input: "Femi san ẹgbẹ̀rún méjì fún garri, ó ku ẹgbẹ̀rún kan."
  - Yoruba Output: [{"customer":"Femi","details":"garri","amount":2000,"type":"income"},{"customer":"Femi","details":"garri","amount":1000,"type":"debt"}]

  - Igbo Input: "Obi kwụrụ puku abụọ maka akpụ, jide puku atọ."
  - Igbo Output: [{"customer":"Obi","details":"akpụ","amount":2000,"type":"income"},{"customer":"Obi","details":"akpụ","amount":3000,"type":"debt"}]
  
  - Hausa Input: "Aisha ta biya dubu biyu na shinkafa, saura dubu daya."
  - Hausa Output: [{"customer":"Aisha","details":"shinkafa","amount":2000,"type":"income"},{"customer":"Aisha","details":"shinkafa","amount":1000,"type":"debt"}]
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

  // Replace your existing determineIntent function
  private determineIntent(text: string): Intent {
    const lowerText = this.normalizeTextForParsing(text);

    // Total Income Keywords
    const incomeQueryKeywords = [
      'total income',
      'pàápàá owó tó wọlé',
      'ego ole m nwetara',
      'kudin shiga gaba daya',
    ];
    if (incomeQueryKeywords.some((kw) => lowerText.includes(kw))) {
      return 'query_total_income';
    }

    // Total Debt Keywords
    const debtQueryKeywords = [
      'total debt',
      'pàápàá gbèsè',
      'ụgwọ ole ka a ji m',
      'bashin gaba daya',
    ];
    if (debtQueryKeywords.some((kw) => lowerText.includes(kw))) {
      return 'query_total_debt';
    }

    // Existing Debtor List Keywords
    const debtorListKeywords = [
      'tani',
      'who',
      'list',
      'show me',
      'awon to je',
      'ndi ji',
      'su wanene',
    ];
    if (debtorListKeywords.some((kw) => lowerText.includes(kw))) {
      return 'query_debtors';
    }

    // Existing Transaction Logging Keywords
    const transactionKeywords = [
      'gba',
      'ji',
      'owes',
      'san',
      'sanwo',
      'kwuru',
      'paid',
      'collected',
      'sold',
      'ta',
      'ku',
      'remaining',
      'biya',
      'karbi',
    ];
    if (transactionKeywords.some((kw) => lowerText.includes(kw))) {
      return 'log_transaction';
    }

    return 'unknown';
  }

  private capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  private normalizeTextForParsing(text: string): string {
    return text
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
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
}
