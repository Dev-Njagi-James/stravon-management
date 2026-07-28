import { Injectable, OnModuleInit } from '@nestjs/common';
import { createClerkClient, ClerkClient, User } from '@clerk/backend';

export interface ClerkUser {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  createdAt: number;
  updatedAt: number;
}

@Injectable()
export class ClerkAdapter implements OnModuleInit {
  private clerk: ClerkClient | null = null;

  onModuleInit(): void {
    const secretKey = process.env.CLERK_SECRET_KEY;
    if (!secretKey) {
      throw new Error(
        'CLERK_SECRET_KEY must be defined in environment variables',
      );
    }
    this.clerk = createClerkClient({ secretKey });
  }

  async getUser(userId: string): Promise<ClerkUser> {
    const user = await this.withTimeout(this.clerk!.users.getUser(userId));
    return this.normalizeUser(user);
  }

  async createUser(params: {
    email: string;
    firstName?: string;
    lastName?: string;
    password?: string;
  }): Promise<ClerkUser> {
    const user = await this.withTimeout(
      this.clerk!.users.createUser({
        emailAddress: [params.email],
        firstName: params.firstName,
        lastName: params.lastName,
        password: params.password,
      }),
    );
    return this.normalizeUser(user);
  }

  async updateUser(
    userId: string,
    params: {
      firstName?: string;
      lastName?: string;
      password?: string;
    },
  ): Promise<ClerkUser> {
    const user = await this.withTimeout(
      this.clerk!.users.updateUser(userId, {
        firstName: params.firstName,
        lastName: params.lastName,
        password: params.password,
      }),
    );
    return this.normalizeUser(user);
  }

  async deleteUser(userId: string): Promise<void> {
    await this.withTimeout(this.clerk!.users.deleteUser(userId));
  }

  private async withTimeout<T>(promise: Promise<T>): Promise<T> {
    const timeoutMs = 5000;

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Clerk request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    return Promise.race([promise, timeoutPromise]);
  }

  private normalizeUser(raw: User): ClerkUser {
    return {
      id: raw.id,
      email:
        raw.emailAddresses?.[0]?.emailAddress ??
        raw.primaryEmailAddress?.emailAddress ??
        '',
      firstName: raw.firstName ?? null,
      lastName: raw.lastName ?? null,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
    };
  }
}
