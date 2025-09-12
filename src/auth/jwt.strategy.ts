import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, ExtractJwt } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { UsersService } from '../users/users.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private configService: ConfigService,
    private usersService: UsersService,
  ) {
    const jwtSecret = configService.get<string>('JWT_SECRET');
    if (!jwtSecret) {
      throw new Error('JWT_SECRET is not defined');
    }
    super({
      // Tell Passport how to find the token
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      // Don't allow expired tokens
      ignoreExpiration: false,
      // The secret key to verify the token's signature
      secretOrKey: jwtSecret,
    });
  }

  // This method runs after the token is successfully verified.
  // The 'payload' is the decoded object from the JWT.
  async validate(payload: { sub: string; username: string }) {
    // We check if the user from the token still exists in the database.
    // This is a good security practice.
    const user = await this.usersService.findById(payload.sub);
    if (!user) {
      throw new UnauthorizedException('User not found.');
    }

    // The object returned here will be attached to the request object as `req.user`
    return { sub: payload.sub, username: payload.username };
  }
}
