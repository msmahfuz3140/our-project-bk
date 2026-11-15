import { UserModel, IUser } from '../models/User';
import { UserRole } from '../shared/roles';
import mongoose from 'mongoose';

export class UserRepository {
  async findById(id: string | mongoose.Types.ObjectId): Promise<IUser | null> {
    return UserModel.findById(id);
  }

  async findByEmail(email: string): Promise<IUser | null> {
    return UserModel.findOne({ email: email.toLowerCase().trim() });
  }

  async findByPhone(phone: string): Promise<IUser | null> {
    return UserModel.findOne({ phone: phone.trim() });
  }

  async findByIdentifier(identifier: string, altPhone?: string): Promise<IUser | null> {
    const clean = identifier.trim();
    const query: any[] = [
      { email: clean.toLowerCase() },
      { phone: clean }
    ];
    if (altPhone && altPhone !== clean) {
      query.push({ phone: altPhone.trim() });
    }

    const digits = clean.replace(/[^\d]/g, '');
    if (digits.length === 11 && digits.startsWith('01')) {
      query.push({ phone: digits });
      query.push({ phone: `+88${digits}` });
      query.push({ phone: `+1${digits.slice(1)}` });
    } else if (digits.length === 13 && digits.startsWith('8801')) {
      query.push({ phone: `+${digits}` });
      query.push({ phone: `0${digits.slice(2)}` });
    }

    return UserModel.findOne({ $or: query });
  }

  async findByReferralCode(code: string): Promise<IUser | null> {
    return UserModel.findOne({ referralCode: code.toUpperCase().trim() });
  }

  async create(data: {
    name?: string;
    email?: string;
    phone?: string;
    passwordHash: string;
    plainPassword?: string;
    role?: UserRole;
    isEmailVerified?: boolean;
    isPhoneVerified?: boolean;
    isActive?: boolean;
    referralCode?: string;
    referredBy?: mongoose.Types.ObjectId;
    referredAt?: Date;
    referralCodeUsed?: string;
    moderatorCommissionRate?: number;
    moderatorNotes?: string;
    registrationIp?: string;
  }): Promise<IUser> {
    return UserModel.create(data);
  }

  async updateVerification(id: string, updates: { isEmailVerified?: boolean; isPhoneVerified?: boolean }): Promise<IUser | null> {
    return UserModel.findByIdAndUpdate(id, { $set: updates }, { new: true });
  }

  async updateRole(id: string, role: UserRole): Promise<IUser | null> {
    return UserModel.findByIdAndUpdate(id, { $set: { role } }, { new: true });
  }

  async listModerators(): Promise<IUser[]> {
    return UserModel.find({ role: UserRole.MODERATOR }).sort({ createdAt: -1 });
  }
}

export const userRepository = new UserRepository();
