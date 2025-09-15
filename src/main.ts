import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { json } from 'express';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.use(json({ limit: '500mb' }));
  app.enableCors({
    // origin: 'https://spitch-hack-backend.onrender.com',
    // methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    // credentials: true,
  });
  await app.listen(process.env.PORT ?? 8000);
}

bootstrap();
