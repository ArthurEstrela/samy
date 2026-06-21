import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { UsersModule } from '../users/users.module';
import { IdentityModule } from '../identity/identity.module';
import { TokenService } from './token.service';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';

@Module({
  imports: [PrismaModule, UsersModule, IdentityModule],
  controllers: [AuthController],
  providers: [TokenService, AuthService],
  exports: [TokenService],
})
export class AuthModule {}
