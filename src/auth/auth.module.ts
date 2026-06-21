import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { UsersModule } from '../users/users.module';
import { TokenService } from './token.service';

@Module({
  imports: [PrismaModule, UsersModule],
  providers: [TokenService],
  exports: [TokenService],
})
export class AuthModule {}
