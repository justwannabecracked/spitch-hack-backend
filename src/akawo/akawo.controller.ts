import {
  Controller,
  Post,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Request,
  Body,
  Get,
  ParseFilePipe,
  MaxFileSizeValidator,
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
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 1000000 }), // 1 MB limit
        ],
      }),
    )
    file: Express.Multer.File,
    @Request() req: { user: { sub: string } },
    @Body() body: { language: 'ig' | 'yo' | 'ha' | 'en' },
  ) {
    this.logger.log(
      `Received file: ${file.originalname}, size: ${file.size}, type: ${file.mimetype}`,
    );

    if (!file.mimetype.startsWith('audio/')) {
      throw new BadRequestException(
        'Validation failed: Uploaded file is not an audio file.',
      );
    }

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
