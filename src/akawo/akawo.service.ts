/* eslint-disable no-case-declarations */
import { Injectable, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Transaction } from './schemas/transaction.schema';
import Spitch from 'spitch';

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
    const transcriptionResponse = await this.spitch.speech.transcribe({
      content: audioBuffer as any,
      language,
    });
    const transcribedText = transcriptionResponse.text;

    if (!transcribedText) {
      throw new BadRequestException(
        'I could not hear anything. Please speak clearly.',
      );
    }

    const intent = this.determineIntent(transcribedText);

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

  private async handleTransactionLogging(
    text: string,
    userId: string,
    language: 'ig' | 'yo' | 'ha' | 'en',
  ) {
    const parsedData = this.parseTransactionText(text);
    if (!parsedData) {
      const errorText = this.generateErrorMessage(language);
      const errorAudio = await this.generateSpeech(errorText, language);
      throw new BadRequestException({
        message: errorText,
        audioContent: errorAudio,
      });
    }

    const newTransaction = new this.transactionModel({
      ...parsedData,
      owner: userId,
    });
    await newTransaction.save();

    const confirmationText = this.generateConfirmationMessage(
      parsedData,
      language,
    );
    const audioContent = await this.generateSpeech(confirmationText, language);

    return {
      type: 'transaction_logged',
      transaction: newTransaction.toObject(),
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
    const lowerText = text.toLowerCase();
    const queryKeywords = ['tani', 'who', 'list', 'show me', 'awon to je'];
    const transactionKeywords = [
      'gba',
      'ji',
      'owes',
      'san',
      'kwụrụ',
      'paid',
      'collected',
      'sold',
      'ta',
    ];

    if (queryKeywords.some((kw) => lowerText.includes(kw))) {
      return 'query_debtors';
    }
    if (transactionKeywords.some((kw) => lowerText.includes(kw))) {
      return 'log_transaction';
    }
    return 'unknown';
  }

  private parseTransactionText(text: string): ParsedTransaction | null {
    console.log(`Parsing text: "${text}"`);
    const patterns = {
      debt: /(?<customer>[\w\s]+?)\s(?:gba|ji|owes|took|collected)\s(?<amount>[\w\s\d]+?)(?:\sfun|\sfor)?\s?(?<details>[\w\s]+)?$/i,
      income:
        /(?<customer>[\w\s]+?)\s(?:san|kwụrụ|paid|gave me)\s(?<amount>[\w\s\d]+?)(?:\sfun|\sfor)?\s?(?<details>[\w\s]+)?$/i,
    };

    let match = text.match(patterns.debt);
    let type: 'debt' | 'income' = 'debt';

    if (!match) {
      match = text.match(patterns.income);
      type = 'income';
    }

    if (match?.groups) {
      const { customer, amount: amountStr, details } = match.groups;
      const amount = this.convertTextToNumber(amountStr.trim());

      if (customer && amount > 0) {
        return {
          customer: customer.trim(),
          details: details?.trim() || 'General transaction',
          amount,
          type,
        };
      }
    }
    return null;
  }

  private convertTextToNumber(text: string): number {
    if (!isNaN(parseInt(text, 10))) return parseInt(text, 10);

    const numberMap: { [key: string]: number } = {
      kan: 1,
      meji: 2,
      meta: 3,
      merin: 4,
      marun: 5,
      mefa: 6,
      meje: 7,
      mejo: 8,
      mesan: 9,
      mewa: 10,
      ogun: 20,
      ogbon: 30,
      ogoji: 40,
      aadota: 50,
      igba: 200,
      egberun: 1000,
      puku: 1000,
      nari: 100,
      thirty: 30,
      fifty: 50,
      thousand: 1000,
    };

    const words = text
      .toLowerCase()
      .trim()
      .split(/[\s-]+/);
    let total = 0;
    let multiplier = 1;

    for (const word of words.reverse()) {
      const value = numberMap[word];
      if (value) {
        if (value >= 1000) {
          total += multiplier * value;
          multiplier = 1;
        } else {
          multiplier = multiplier === 1 ? value : multiplier * value;
        }
      }
    }
    total += multiplier > 1 ? multiplier : 0;

    if (words.includes('egberun') && total < 1000) {
      const thousandIndex = words.indexOf('egberun');
      if (thousandIndex > 0) {
        const multiplierWord = words[thousandIndex - 1];
        if (numberMap[multiplierWord]) {
          return numberMap[multiplierWord] * 1000;
        }
      }
    }

    return total > 0 ? total : parseInt(text.replace(/,/g, ''), 10) || 0;
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

  private async generateSpeech(
    text: string,
    language: 'ig' | 'yo' | 'ha' | 'en',
  ): Promise<string> {
    const voice = this.getVoiceForLanguage(language);
    const ttsResponse = await this.spitch.speech.generate({
      text,
      language,
      voice,
    });
    return Buffer.from(await ttsResponse.arrayBuffer()).toString('base64');
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
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return messages[lang];
  }

  private generateConfirmationMessage(
    data: ParsedTransaction,
    lang: string,
  ): string {
    const { customer, amount, type, details } = data;
    switch (lang) {
      case 'yo':
        return `O dáa. Mo ti kọ sílẹ̀ pé ${customer} ${
          type === 'debt' ? 'gba' : 'san'
        } ₦${amount.toLocaleString()} fun ${details}.`;
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
