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
type Intent = 'log_transaction' | 'query_debtors' | 'unknown';

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

    try {
      const transcribedText = await this.transcribeAudioWithGemini(
        tempFilePath,
        language,
      );

      if (!transcribedText) {
        throw new BadRequestException(
          'I could not understand the audio. Please speak clearly.',
        );
      }
      this.logger.log(`Gemini Transcribed Text: "${transcribedText}"`);

      const intent = this.determineIntent(transcribedText);
      this.logger.log(`Determined Intent: "${intent}"`);

      // After processing, clean up the original uploaded file
      await fs.unlink(tempFilePath);
      this.logger.log(`Cleaned up temporary upload file: ${tempFilePath}`);

      switch (intent) {
        case 'log_transaction':
          return this.handleTransactionLogging(
            transcribedText,
            userId,
            language,
          );
        case 'query_debtors':
          return this.handleDebtorQuery(userId, language);
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
      // Ensure cleanup happens even if there's an error
      await fs
        .unlink(tempFilePath)
        .catch((e) =>
          this.logger.error(
            `Failed to clean up file on error: ${tempFilePath}`,
            e,
          ),
        );
      this.logger.error('Error in main audio processing pipeline', error.stack);
      if (error instanceof BadRequestException) throw error;
      throw new InternalServerErrorException(
        'A server error occurred while processing your request.',
      );
    }
  }

  private async transcribeAudioWithGemini(
    filePath: string,
    language: string,
  ): Promise<string | null> {
    this.logger.debug('Transcribing audio with Gemini from file path...');
    const model = this.genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

    // Convert the original webm file to a wav file for Gemini
    const wavFilePath = await this.convertWebmToWav(filePath);

    const prompt = `Transcribe the following audio recording. The primary language is ${language}.`;

    try {
      const audioBuffer = await fs.readFile(wavFilePath);
      const audioPart = {
        inlineData: {
          data: audioBuffer.toString('base64'),
          mimeType: 'audio/wav',
        },
      };

      const result = await model.generateContent([prompt, audioPart]);
      return result.response.text().trim();
    } catch (error) {
      this.logger.error('Error during Gemini transcription', error);
      return null;
    } finally {
      // Clean up the converted wav file
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
      You are an expert accounting assistant for a Nigerian market trader named Akawo.
      Your task is to analyze transcribed voice commands in Nigerian languages (English, Yoruba, Igbo, Hausa) and extract transaction details with precision.
      Keywords for PAID: "san", "sanwo", "paid", "kwụrụ", "biya".
      Keywords for DEBT/OWED: "ku", "kú", "owes", "remaining", "ji", "karbi".
      RULES:
      - A sentence can contain both an income and a debt.
      - If no customer is found, use "Oníbàárà". If no details are found, use "Ọjà".
      - Convert spoken numbers (e.g., "ẹgbẹ̀rún méjì") into digits (e.g., 2000).
      - Your response MUST be a valid JSON array of objects with keys: "customer", "details", "amount", and "type" ("income" or "debt").
      - If no valid transaction is found, return an empty array: [].
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

  private determineIntent(text: string): Intent {
    const lowerText = this.normalizeTextForParsing(text);
    const queryKeywords = [
      'tani',
      'who',
      'list',
      'show me',
      'awon to je',
      'ndi ji',
      'su wanene',
    ];
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

    if (queryKeywords.some((kw) => lowerText.includes(kw))) {
      return 'query_debtors';
    }
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
    lang: string,
  ): string {
    if (transactions.length === 0) return this.generateErrorMessage(lang);
    if (transactions.length === 1) {
      return this.generateConfirmationMessage(
        transactions[0] as ParsedTransaction,
        lang,
      );
    }

    const summary = transactions
      .map(
        (tx) =>
          `${tx.type === 'debt' ? 'gbèsè' : 'ìsanwó'} ₦${tx.amount.toLocaleString()}`,
      )
      .join(' àti ');

    const customer = transactions[0].customer;

    return `O dáa. Mo ti kọ sílẹ̀: ${summary} fún ${customer}.`;
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
}
