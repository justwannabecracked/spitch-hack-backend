import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { User } from '../../users/schemas/user.schema';

@Schema({ timestamps: true })
export class Transaction extends Document {
  @Prop({ required: true })
  customer: string;

  @Prop({ required: true })
  details: string;

  @Prop({ required: true })
  amount: number;

  @Prop({ required: true, enum: ['income', 'debt'] })
  type: string;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  owner: User;
}

export const TransactionSchema = SchemaFactory.createForClass(Transaction);
