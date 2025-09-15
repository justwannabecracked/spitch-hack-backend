import {
  Controller,
  Post,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Request,
  Body,
  Get,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AkawoService } from './akawo.service';

@Controller('api/v1/akawo')
export class AkawoController {
  private readonly logger = new Logger(AkawoController.name);

  constructor(private akawoService: AkawoService) {}

  @UseGuards(JwtAuthGuard)
  @Post('process-audio')
  @UseInterceptors(FileInterceptor('audio'))
  async processAudio(
    // The @UploadedFile decorator now provides a file object with a path property.
    @UploadedFile() file: Express.Multer.File,
    @Request() req: { user: { sub: string } },
    @Body() body: { language: 'ig' | 'yo' | 'ha' | 'en' },
  ) {
    // A crucial check to ensure a file was actually uploaded.
    if (!file) {
      throw new BadRequestException('No audio file uploaded.');
    }

    this.logger.log(
      `File upload complete. Path: ${file.path}, Size: ${file.size} bytes`,
    );

    const userId = req.user.sub;
    // We now pass the file path to the service instead of the in-memory buffer.
    return this.akawoService.processAudioCommand(
      file.path,
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
