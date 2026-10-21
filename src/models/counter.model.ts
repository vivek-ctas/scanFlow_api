import mongoose, { Document, Schema, Model } from 'mongoose';

/**
 * Single-document atomic counter. A `findOneAndUpdate({_id}, {$inc:{seq:1}},
 * {upsert:true, new:true})` yields the next value without a Mongo transaction,
 * which the deployment (possibly a standalone instance) cannot provide.
 */
export interface ICounter extends Document<string> {
  _id: string;
  seq: number;
}

const counterSchema = new Schema<ICounter>({
  _id: { type: String },
  seq: { type: Number, default: 0 },
});

export const Counter =
  (mongoose.models.tbl_counter as Model<ICounter>) ||
  mongoose.model<ICounter>('tbl_counter', counterSchema);

/** Atomically reserves and returns the next ticket sequence value. */
export const nextTicketSeq = async (): Promise<number> => {
  const doc = await Counter.findOneAndUpdate(
    { _id: 'support_ticket' },
    { $inc: { seq: 1 } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();
  return doc?.seq ?? 1;
};
