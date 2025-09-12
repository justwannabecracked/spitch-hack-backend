import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getAppStatus(): object {
    return {
      status: 'ok',
      message: 'Welcome to the Akawo API! The server is up and running.',
      timestamp: new Date().toISOString(),
    };
  }
}
