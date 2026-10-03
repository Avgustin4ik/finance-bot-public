export type TransactionType = "Доход" | "Расход";

export interface ExpenseRecord {
  date: string;
  type: TransactionType;
  source: string;
  amount: number;
  currency: string;
  category: string;
  description: string;
}
