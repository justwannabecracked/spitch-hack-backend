import {
  Controller,
  Post,
  UseGuards,
  Request,
  Body,
  Get,
  Logger,
} from '@nestjs/common';
// We no longer need FileInterceptor or UploadedFile, so they are removed.
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AkawoService } from './akawo.service';

@Controller('api/v1/akawo')
export class AkawoController {
  private readonly logger = new Logger(AkawoController.name);

  constructor(private akawoService: AkawoService) {}

  @UseGuards(JwtAuthGuard)
  @Post('process-audio')
  async processAudio(
    @Request() req: { user: { sub: string } },
    @Body() body: { language: 'ig' | 'yo' | 'ha' | 'en'; audio: string },
  ) {
    this.logger.log(
      `Received process-audio request for user ${req.user.sub} in language: ${body.language}`,
    );

    const userId = req.user.sub;

    const audioBuffer = Buffer.from(body.audio, 'base64');

    return this.akawoService.processAudioCommand(
      audioBuffer,
      userId,
      body.language,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Get('transactions')
  async getTransactions(@Request() req: { user: { sub: string } }) {
    const userId = req.user.sub;
    return this.akawoService.getTransactionsForUser(userId);
  }
}
