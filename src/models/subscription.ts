export interface Subscription {
  payhere_sub_id: string; // Primary key
  user_id: string;
  package_id: string;
  is_active: boolean;
  created_at?: Date;
  updated_at?: Date;
}

export interface SubscriptionDetails {
  payhere_sub_id: string;
  user_id: string;
  package_id: string;
  is_active: boolean;
  created_at?: Date;
  updated_at?: Date;
  subscription_start_date: Date;
  dca_price: number;
  next_billing_date: Date;
  package_name: string;
  frequency: 'weekly' | 'monthly';
}
