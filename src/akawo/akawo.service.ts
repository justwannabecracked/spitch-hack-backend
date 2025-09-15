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
import { createReadStream } from 'fs';
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
    audioBuffer: Buffer,
    userId: string,
    language: 'ig' | 'yo' | 'ha' | 'en' = 'en',
  ) {
    this.logger.log(
      `Processing audio command for user ${userId} in language: ${language}`,
    );

    try {
      // Use a temporary text file to get the initial transcription for intent routing
      const tempWavPath = path.join(
        os.tmpdir(),
        `intent-audio-${Date.now()}.wav`,
      );
      await fs.writeFile(tempWavPath, await this.convertWebmToWav(audioBuffer));
      const fileStream = createReadStream(tempWavPath);
      const transcriptionResponse = await this.spitch.speech.transcribe({
        content: fileStream as any,
        language,
      });
      await fs.unlink(tempWavPath);

      if (!transcriptionResponse.text) {
        throw new BadRequestException(
          'I could not hear anything. Please speak clearly.',
        );
      }

      this.logger.log(
        `Transcribed Text for Intent: "${transcriptionResponse.text}"`,
      );
      const intent = this.determineIntent(transcriptionResponse.text);
      this.logger.log(`Determined Intent: "${intent}"`);

      if (intent === 'query_debtors') {
        return this.handleDebtorQuery(userId, language);
      }

      // If the intent is to log a transaction, use Gemini for high-accuracy parsing from audio
      return this.handleTransactionLoggingWithGemini(
        audioBuffer,
        userId,
        language,
      );
    } catch (error) {
      this.logger.error('Error in main audio processing pipeline', error.stack);
      const errorText = this.generateErrorMessage(language);
      const errorAudio = await this.generateSpeech(errorText, language, userId);
      throw new BadRequestException({
        message: errorText,
        audioContent: errorAudio,
      });
    }
  }

  private async handleTransactionLoggingWithGemini(
    audioBuffer: Buffer,
    userId: string,
    language: 'ig' | 'yo' | 'ha' | 'en',
  ) {
    this.logger.log(
      'Handling transaction logging with Gemini V5 multimodal...',
    );

    // Convert the original audio buffer to WAV for Gemini
    const wavBuffer = await this.convertWebmToWav(audioBuffer);
    const parsedTransactions = await this.parseIntelligentV5(wavBuffer);

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

  /**
   * V5 - The Multimodal LLM-Powered Intelligent Parser
   * This function takes the AUDIO BUFFER directly.
   */
  private async parseIntelligentV5(
    audioBuffer: Buffer,
  ): Promise<ParsedTransaction[]> {
    this.logger.debug(`V5 Parsing with Gemini Multimodal Audio.`);

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
      Your task is to LISTEN to a voice command in a Nigerian language (English, Yoruba, Igbo, Hausa) and extract transaction details with precision.

      You will be given an audio file. You must identify these key entities from the speech:
      1.  "customer": The name of the person involved.
      2.  "details": The item or service that was sold.
      3.  "income": The amount of money PAID.
      4.  "debt": The amount of money REMAINING or OWED.

      RULES:
      - A single command can contain both an income and a debt.
      - If you cannot identify a customer, use a generic term like "Customer" or "Oníbàárà".
      - If you cannot identify details, use a generic term like "Goods" or "Ọjà".
      - Your response MUST be a valid JSON array of objects.
      - Each object in the array represents a single transaction and must have the keys: "customer", "details", "amount", and "type" (either "income" or "debt").
      - If you cannot understand the audio or find any valid transaction details, return an empty array: [].
    `;

    try {
      const audioPart = {
        inlineData: {
          data: audioBuffer.toString('base64'),
          mimeType: 'audio/wav',
        },
      };

      const result = await model.generateContent([systemPrompt, audioPart]);
      const llmResponseText = result.response.text();
      this.logger.debug(`LLM Raw Response from Audio: ${llmResponseText}`);

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
        'Error calling or parsing response from Gemini API with audio',
        error,
      );
      return [];
    }
  }

  // --- All other helper functions remain the same ---
  // ... (convertWebmToWav, handleDebtorQuery, getTransactionsForUser, determineIntent, etc.)
  private convertWebmToWav(inputBuffer: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const tempInputPath = path.join(os.tmpdir(), `input-${Date.now()}.webm`);
      const tempOutputPath = path.join(os.tmpdir(), `output-${Date.now()}.wav`);

      fs.writeFile(tempInputPath, inputBuffer)
        .then(() => {
          ffmpeg(tempInputPath)
            .toFormat('wav')
            .on('error', (err) => {
              this.logger.error('FFmpeg error:', err.message);
              fs.unlink(tempInputPath).catch((e) =>
                this.logger.error('Failed to clean up input file', e),
              );
              reject(
                new InternalServerErrorException(
                  'Failed to convert audio file.',
                ),
              );
            })
            .on('end', () => {
              fs.readFile(tempOutputPath)
                .then(async (outputBuffer) => {
                  await fs.unlink(tempInputPath);
                  await fs.unlink(tempOutputPath);
                  resolve(outputBuffer);
                })
                .catch(reject);
            })
            .save(tempOutputPath);
        })
        .catch(reject);
    });
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
