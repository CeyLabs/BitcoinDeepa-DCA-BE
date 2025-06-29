export interface Subscription {
  payhere_sub_id: string; // Primary key
  user_id: string;
  package_id: string;
  is_active: boolean;
  created_at?: Date;
  updated_at?: Date;
}
