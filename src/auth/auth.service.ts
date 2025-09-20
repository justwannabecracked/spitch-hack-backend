import {
  Injectable,
  UnauthorizedException,
  ConflictException,
} from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { SignUpDto, LoginDto } from './dto/auth.dto';

const AVATAR_URLS = [
  [
    'https://ik.imagekit.io/ubdvpx7xd0j/Femi_Obadimu/Rectangle%2013_-ItkkhOd7.png?updatedAt=1758370164352',
    'https://ik.imagekit.io/ubdvpx7xd0j/Femi_Obadimu/Rectangle%2020_qxzZpvdhb.png?updatedAt=1758370078897',
  ],
  [
    'https://ik.imagekit.io/ubdvpx7xd0j/Femi_Obadimu/Rectangle%2021_WBA2L3Exq.png?updatedAt=1758370100567',
    'https://ik.imagekit.io/ubdvpx7xd0j/Femi_Obadimu/Rectangle%2022_xzv-HM-RiH.png?updatedAt=1758369967881',
  ],
  [
    'https://ik.imagekit.io/ubdvpx7xd0j/Femi_Obadimu/Rectangle%2020_qxzZpvdhb.png?updatedAt=1758370078897',
    'https://ik.imagekit.io/ubdvpx7xd0j/Femi_Obadimu/Rectangle%2021_WBA2L3Exq.png?updatedAt=1758370100567',
  ],
  [
    'https://ik.imagekit.io/ubdvpx7xd0j/Femi_Obadimu/Rectangle%2024_IhN-swPK9Y.png?updatedAt=1758369967892',
    'https://ik.imagekit.io/ubdvpx7xd0j/Femi_Obadimu/Rectangle%2013_-ItkkhOd7.png?updatedAt=1758370164352',
  ],
  [
    'https://ik.imagekit.io/ubdvpx7xd0j/Femi_Obadimu/Rectangle%2022_xzv-HM-RiH.png?updatedAt=1758369967881',
    'https://ik.imagekit.io/ubdvpx7xd0j/Femi_Obadimu/Rectangle%2024_IhN-swPK9Y.png?updatedAt=1758369967892',
  ],
];

@Injectable()
export class AuthService {
  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
  ) {}

  async signUp(signUpDto: SignUpDto) {
    const { username, email, password } = signUpDto;
    const existingUser = await this.usersService.findByEmail(email);
    if (existingUser) {
      throw new ConflictException('Email already in use.');
    }

    const image = this.getRandomAvatarUrl();

    const password_hash = await bcrypt.hash(password, 10);
    const user = await this.usersService.create(
      username,
      email,
      password_hash,
      image,
    );

    const payload = {
      sub: user._id,
      username: user.username,
      email: user.email,
      image: user.image,
    };
    return {
      accessToken: this.jwtService.sign(payload),
      user,
    };
  }

  async login(loginDto: LoginDto) {
    const { email, password } = loginDto;
    const user = await this.usersService.findByEmail(email);
    if (!user) {
      throw new UnauthorizedException('Invalid credentials.');
    }

    const isPasswordMatching = await bcrypt.compare(
      password,
      user.password_hash,
    );
    if (!isPasswordMatching) {
      throw new UnauthorizedException('Invalid credentials.');
    }

    const payload = {
      sub: user._id,
      username: user.username,
      email: user.email,
      image: user.image,
    };
    return {
      accessToken: this.jwtService.sign(payload),
      user,
    };
  }

  async getProfile(userId: string) {
    const user = await this.usersService.findById(userId);
    if (!user) {
      throw new UnauthorizedException('User not found.');
    }
    return {
      user,
    };
  }
  private getRandomAvatarUrl(): string {
    const randomCategoryIndex = Math.floor(Math.random() * AVATAR_URLS.length);
    const selectedCategory = AVATAR_URLS[randomCategoryIndex];

    const randomImageIndex = Math.floor(
      Math.random() * selectedCategory.length,
    );
    const selectedImageUrl = selectedCategory[randomImageIndex];

    return selectedImageUrl;
  }
}
