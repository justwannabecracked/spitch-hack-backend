import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { UsersService } from './users.service';
import { User, UserSchema } from './schemas/user.schema';

@Module({
  imports: [
    // This makes the User model available for injection in this module
    MongooseModule.forFeature([{ name: User.name, schema: UserSchema }]),
  ],
  providers: [UsersService],
  // This line is essential. It makes UsersService available to any other module that imports UsersModule.
  exports: [UsersService],
})
export class UsersModule {}
