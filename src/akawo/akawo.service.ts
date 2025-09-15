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
import * as path from 'path';
import * as os from 'os';
import { createReadStream } from 'fs';
import ffmpeg = require('fluent-ffmpeg');
import { File } from 'node:buffer';

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

@Injectable()
export class AkawoService {
  private spitch: Spitch;
  private readonly logger = new Logger(AkawoService.name);

  constructor(
    private configService: ConfigService,
    @InjectModel(Transaction.name) private transactionModel: Model<Transaction>,
  ) {
    const apiKey = this.configService.get<string>('SPITCH_API_KEY');
    if (!apiKey) {
      throw new Error(
        'SPITCH_API_KEY is not defined in environment variables.',
      );
    }
    this.spitch = new Spitch({ apiKey });
  }

  async processAudioCommand(
    audioBuffer: Buffer,
    userId: string,
    language: 'ig' | 'yo' | 'ha' | 'en' = 'en',
  ) {
    this.logger.log(
      `Processing audio command for user ${userId} in language: ${language}`,
    );

    let transcriptionResponse;
    const tempWavPath = path.join(os.tmpdir(), `final-audio-${Date.now()}.wav`);

    try {
      this.logger.log('Starting audio conversion from webm to wav...');
      const wavBuffer = await this.convertWebmToWav(audioBuffer);
      this.logger.log('Audio conversion successful.');

      await fs.writeFile(tempWavPath, wavBuffer);
      this.logger.log(`WAV buffer saved to temporary file: ${tempWavPath}`);

      const fileStream = createReadStream(tempWavPath);

      transcriptionResponse = await this.spitch.speech.transcribe({
        content: fileStream as any,
        language,
      });
    } catch (error) {
      this.logger.error(
        'Error during audio conversion or Spitch transcription',
        error.stack,
      );
      if (error.status && error.error?.detail) {
        throw new BadRequestException(
          `Spitch API Error: ${error.error.detail}`,
        );
      }
      throw new InternalServerErrorException(
        'A server error occurred while processing the audio.',
      );
    } finally {
      try {
        await fs.unlink(tempWavPath);
        this.logger.log(`Temporary WAV file deleted: ${tempWavPath}`);
      } catch (cleanupError) {
        this.logger.error(
          `Failed to delete temporary WAV file: ${tempWavPath}`,
          cleanupError,
        );
      }
    }

    const transcribedText = transcriptionResponse.text;
    this.logger.log(`Transcribed Text: "${transcribedText}"`);

    if (!transcribedText) {
      throw new BadRequestException(
        'I could not hear anything. Please speak clearly.',
      );
    }

    const intent = this.determineIntent(transcribedText);
    this.logger.log(`Determined Intent: "${intent}"`);

    switch (intent) {
      case 'log_transaction':
        return this.handleTransactionLogging(transcribedText, userId, language);
      case 'query_debtors':
        return this.handleDebtorQuery(userId, language);
      default:
        const errorText = this.generateErrorMessage(language);
        const errorAudio = await this.generateSpeech(errorText, language);
        throw new BadRequestException({
          message: errorText,
          audioContent: errorAudio,
        });
    }
  }

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

  private async handleTransactionLogging(
    text: string,
    userId: string,
    language: 'ig' | 'yo' | 'ha' | 'en',
  ) {
    const parsedTransactions = this.parseIntelligent(text);

    if (parsedTransactions.length === 0) {
      const errorText = this.generateErrorMessage(language);
      const errorAudio = await this.generateSpeech(errorText, language);
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
    const audioContent = await this.generateSpeech(confirmationText, language);

    return {
      type: 'transaction_logged',
      transactions: savedTransactions,
      audioContent,
      confirmationText,
    };
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

    const audioContent = await this.generateSpeech(responseText, language);

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
    const queryKeywords = ['tani', 'who', 'list', 'show me', 'awon to je'];
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
    ];

    if (queryKeywords.some((kw) => lowerText.includes(kw))) {
      return 'query_debtors';
    }
    if (transactionKeywords.some((kw) => lowerText.includes(kw))) {
      return 'log_transaction';
    }
    return 'unknown';
  }

  /**
   * V3 - Intelligent Parser
   */
  private parseIntelligent(text: string): ParsedTransaction[] {
    this.logger.debug(`V3 Parsing original text: "${text}"`);
    const transactions: ParsedTransaction[] = [];
    const normalizedText = this.normalizeTextForParsing(text);
    this.logger.debug(`Normalized text for V3 parsing: "${normalizedText}"`);

    const customerMatch = normalizedText.match(
      /(?:fun|to)\s(?<customer>[\w\s]+?)(?:,|$|\sfun|\sto\s)/i,
    );
    const customer = customerMatch?.groups?.customer.trim() || 'Onibara';
    this.logger.debug(`V3 Found Customer: "${customer}"`);

    const detailsMatch = normalizedText.match(
      /(?:ta|sold)\s(?<details>.*?)\s?(?:fun|to)/i,
    );
    const details = detailsMatch?.groups?.details.trim() || 'Oja';
    this.logger.debug(`V3 Found Details: "${details}"`);

    // Flexible patterns for income and debt amounts
    const incomePattern = /(?:san|sanwo|paid)\s(?<amount>[\w\s\d,-]+)/gi;
    const debtPattern = /(?:ku|owes|remaining)\s(?<amount>[\w\s\d,-]+)/gi;

    let match;
    while ((match = incomePattern.exec(normalizedText)) !== null) {
      if (match.groups?.amount) {
        const amount = this.convertTextToNumber(match.groups.amount.trim());
        this.logger.debug(
          `V3 Found Income Amount (text): "${match.groups.amount}", (parsed): ${amount}`,
        );
        if (amount > 0) {
          transactions.push({
            customer: this.capitalize(customer),
            details: `Isanwo fun ${this.capitalize(details)}`,
            amount,
            type: 'income',
          });
        }
      }
    }

    while ((match = debtPattern.exec(normalizedText)) !== null) {
      if (match.groups?.amount) {
        const amount = this.convertTextToNumber(match.groups.amount.trim());
        this.logger.debug(
          `V3 Found Debt Amount (text): "${match.groups.amount}", (parsed): ${amount}`,
        );
        if (amount > 0) {
          transactions.push({
            customer: this.capitalize(customer),
            details: `Gbese fun ${this.capitalize(details)}`,
            amount,
            type: 'debt',
          });
        }
      }
    }

    if (transactions.length === 0) {
      this.logger.warn('V3 Parsing failed to find any valid transactions.');
    }

    return transactions;
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

  private convertTextToNumber(text: string): number {
    const numberMap: { [key: string]: { value: number; multiplier: boolean } } =
      {
        kan: { value: 1, multiplier: false },
        meji: { value: 2, multiplier: false },
        meta: { value: 3, multiplier: false },
        mewa: { value: 10, multiplier: false },
        ogun: { value: 20, multiplier: false },
        ogbon: { value: 30, multiplier: false },
        igba: { value: 200, multiplier: true },
        egberun: { value: 1000, multiplier: true },
        thousand: { value: 1000, multiplier: true },
      };

    let total = 0;
    const words = text.toLowerCase().replace(/,/g, '').split(/\s+/);

    let currentVal = 0;
    for (const word of words) {
      if (!isNaN(parseInt(word))) {
        currentVal += parseInt(word);
      } else if (numberMap[word]) {
        if (numberMap[word].multiplier) {
          currentVal =
            currentVal === 0
              ? numberMap[word].value
              : currentVal * numberMap[word].value;
        } else {
          currentVal += numberMap[word].value;
        }
      } else if (word === 'o' || word === 'le') {
        // Handle Yoruba "and" for addition
        total += currentVal;
        currentVal = 0;
      }
    }
    total += currentVal;

    return total > 0 ? total : parseInt(text.replace(/,/g, '')) || 0;
  }

  private getVoiceForLanguage(
    lang: 'ig' | 'yo' | 'ha' | 'en',
  ):
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
    | 'tesfaye' {
    const voiceMap: Record<
      'yo' | 'ig' | 'ha' | 'en',
      'sade' | 'ngozi' | 'amina' | 'john'
    > = {
      yo: 'sade',
      ig: 'ngozi',
      ha: 'amina',
      en: 'john',
    };
    return voiceMap[lang] || 'sade';
  }

  private normalizeTextForTTS(text: string): string {
    return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  private async generateSpeech(
    text: string,
    language: 'ig' | 'yo' | 'ha' | 'en',
  ): Promise<string | null> {
    try {
      const voice = this.getVoiceForLanguage(language);
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
