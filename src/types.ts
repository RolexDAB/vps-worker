export interface BackgroundJob {
  job_id: string;
  user_id: string;
  job_type: string;
  payload: any;
  related_record_id: string;
  related_record_type: string;
  attempts: number;
}

export interface MealPlanJobPayload {
  userId: string;
  userPreferences: FoodPreferences;
  planId: string;
  requestTimestamp: string;
  authContext: {
    authenticatedUserId?: string;
    requestedUserId: string;
  };
}

export interface FoodPreferences {
  goal?: string;
  dietaryRestrictions?: string[];
  dietTypes?: string[];
  cuisinePreferences?: string[];
  likedIngredients?: string[];
  dislikedIngredients?: string[];
  allergies?: string[];
  mealsPerDay: number;
  budget?: string;
  cookingSkill?: string;
  spiceLevel?: string;
  cookingTime?: string;
  favoriteDishes?: string[];
  allowMealRepeats?: boolean;
  measurementSystem?: 'metric' | 'imperial';
  cheatDays?: Array<{
    date: string;
    calories: number;
  }>;
}

export interface MealPlanDay {
  day: string;
  date: string;
  daily_calorie_target: number;
  isCheatDay: boolean;
  meals: Meal[];
  daily_totals: {
    calories: number;
    protein: number;
    carbs: number;
    fats: number;
  };
}

export interface Meal {
  type: string;
  name: string;
  englishName: string;
  description: string;
  image_search_keywords: string[];
  nutritionalInfo: {
    calories: number;
    protein: number;
    carbs: number;
    fats: number;
  };
  ingredients: string[];
  instructions: string[];
  preparationTime: string;
  portionSize: string;
  image?: string;
}

export interface ShoppingListCategory {
  category: string;
  items: Array<{
    name: string;
    quantity_needed_for_week: string;
  }>;
}

export interface MealPlanResult {
  overview: {
    goal: string;
    average_calorie_target: number;
    average_protein_target: number;
    average_carbs_target: number;
    average_fats_target: number;
    summary: string;
    measurement_system_used: string;
  };
  days: MealPlanDay[];
  shopping_list: ShoppingListCategory[];
  recommendations: {
    meal_timing_suggestions: string[];
    food_categories: {
      recommended: string[];
      limit: string[];
      avoid: string[];
    };
  };
  guidelines: Array<{
    title: string;
    description: string;
    action_items: string[];
  }>;
  diet_cards?: Array<{
    title: string;
    description: string;
    icon: string;
  }>;
}

export interface WorkerConfig {
  workerId: string;
  pollIntervalMs: number;
  maxConcurrentJobs: number;
  logLevel: string;
}