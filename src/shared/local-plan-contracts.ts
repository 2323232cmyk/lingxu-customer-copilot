export interface LocalPlan {
  id: string;
  title: string;
  dueAt: string;
  done: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LocalPlanCreateInput {
  accountKey: string;
  title: string;
  dueAt: string;
}

export interface LocalPlanUpdateInput {
  accountKey: string;
  id: string;
  title?: string;
  dueAt?: string;
  done?: boolean;
}

export interface LocalPlanDeleteInput {
  accountKey: string;
  id: string;
}
