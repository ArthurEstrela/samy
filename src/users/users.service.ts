import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

interface CreateUserInput {
  role: 'CLIENT' | 'MODEL';
  provider: string;
  subject: string;
  email: string;
  name: string;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  findByProvider(provider: string, subject: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { provider_providerSubject: { provider, providerSubject: subject } },
    });
  }

  findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  createUser(input: CreateUserInput): Promise<User> {
    const status = input.role === 'MODEL' ? 'PENDING_VERIFICATION' : 'ACTIVE';
    return this.prisma.user.create({
      data: {
        role: input.role,
        provider: input.provider,
        providerSubject: input.subject,
        email: input.email,
        displayName: input.name,
        status,
      },
    });
  }

  async setStatus(id: string, status: 'ACTIVE' | 'SUSPENDED'): Promise<User> {
    try {
      return await this.prisma.user.update({ where: { id }, data: { status } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        throw new NotFoundException('User not found');
      }
      throw err;
    }
  }

  accountOf(user: { id: string; role: string }): string {
    return `${user.role.toLowerCase()}:${user.id}`;
  }
}
