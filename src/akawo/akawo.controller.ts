import {
  Controller,
  Post,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Request,
  Body,
  Get,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AkawoService } from './akawo.service';

@Controller('api/v1/akawo')
export class AkawoController {
  constructor(private akawoService: AkawoService) {}

  @UseGuards(JwtAuthGuard)
  @Post('process-audio')
  @UseInterceptors(FileInterceptor('audio'))
  async processAudio(
    @UploadedFile() file: Express.Multer.File,
    @Request() req: { user: { sub: string } },
    @Body() body: { language: 'ig' | 'yo' | 'ha' | 'en' },
  ) {
    const userId = req.user.sub;
    return this.akawoService.processAudioCommand(
      file.buffer,
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
