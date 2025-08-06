import OpenAI from 'openai';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { logger } from './logger.js';
import { FoodPreferences, MealPlanResult, MealPlanDay, Meal } from './types.js';

// Language mapping for OpenAI prompts
const LANGUAGE_INSTRUCTIONS = {
  'en': 'Generate all content in English.',
  'es': 'Genera todo el contenido en español.',
  'fr': 'Générez tout le contenu en français.',
  'de': 'Generieren Sie alle Inhalte auf Deutsch.',
  'it': 'Genera tutti i contenuti in italiano.',
  'pt': 'Gere todo o conteúdo em português.',
  'ru': 'Генерируйте весь контент на русском языке.',
  'zh': '用中文生成所有内容。',
  'ja': '全てのコンテンツを日本語で生成してください。',
  'ko': '모든 콘텐츠를 한국어로 생성하세요.',
  'ro': 'Generați tot conținutul în română.'
} as const;

// Global cache to prevent duplicate images in the same meal plan
let usedImageUrls = new Set<string>();

export class MealPlanGenerator {
  private openai: OpenAI;
  private supabase: SupabaseClient;
  private unsplashAccessKey?: string;

  constructor(
    openaiApiKey: string,
    supabaseUrl: string,
    supabaseServiceKey: string,
    unsplashAccessKey?: string
  ) {
    this.openai = new OpenAI({ apiKey: openaiApiKey });
    this.supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });
    this.unsplashAccessKey = unsplashAccessKey;
  }

  async generateMealPlan(
    userId: string,
    userPreferences: FoodPreferences,
    planId: string
  ): Promise<MealPlanResult> {
    try {
      logger.info('🚀 Starting meal plan generation', { userId, planId });
      
      // Clear image cache for new meal plan
      usedImageUrls.clear();

      // 1. Fetch user profile and food history
      const userProfile = await this.fetchUserProfile(userId);
      const foodHistory = await this.fetchFoodHistory(userId);
      
      // 2. Generate meal plan using OpenAI
      const aiResponse = await this.generateMealPlanWithAI(
        userPreferences,
        userProfile,
        foodHistory
      );

      // 3. Fetch images for meals
      await this.fetchMealImages(aiResponse);

      // 4. Generate diet cards
      const dietCards = await this.generateDietCards(
        userPreferences,
        foodHistory,
        userProfile.language || 'en'
      );

      // 5. Assemble final result
      const result: MealPlanResult = {
        ...aiResponse,
        diet_cards: dietCards
      };

      logger.info('✅ Meal plan generation completed', { userId, planId });
      return result;

    } catch (error) {
      const err = error as Error;
      logger.error('💥 Meal plan generation failed', { 
        userId, 
        planId, 
        error: err.message,
        stack: err.stack 
      });
      throw error;
    }
  }

  private async fetchUserProfile(userId: string) {
    try {
      const { data, error } = await this.supabase
        .from('user_profiles')
        .select('profile_data')
        .eq('user_id', userId)
        .single();

      if (error && error.code !== 'PGRST116') {
        logger.error('Error fetching user profile', { userId, error });
        throw error;
      }

      return data?.profile_data || {};
    } catch (error) {
      logger.warn('Could not fetch user profile, using defaults', { userId });
      return {};
    }
  }

  private async fetchFoodHistory(userId: string) {
    try {
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      const { data: foodEntries, error } = await this.supabase
        .from('food_entries')
        .select(`
          id, date, meal_type, total_calories,
          food_items (name, calories, protein, carbs, fats, portion_size)
        `)
        .eq('user_id', userId)
        .gte('date', sevenDaysAgo.toISOString().split('T')[0])
        .order('date', { ascending: false });

      if (error) {
        logger.warn('Could not fetch food history', { userId, error });
        return 'No food entries for the last 7 days.';
      }

      if (!foodEntries || foodEntries.length === 0) {
        return 'No food entries for the last 7 days.';
      }

      return foodEntries.map(entry => 
        `Date: ${entry.date}, Meal: ${entry.meal_type}, Cals: ${entry.total_calories}, Foods: ` +
        (entry.food_items?.map(item => 
          `${item.name}(${item.calories}kcal P:${item.protein}g C:${item.carbs}g F:${item.fats}g)`
        ).join('; ') || 'N/A')
      ).join('\n');

    } catch (error) {
      logger.warn('Exception fetching food history', { userId, error });
      return 'No food entries for the last 7 days.';
    }
  }

  private getCurrentWeekDates(): Date[] {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(today);
      d.setDate(today.getDate() + i);
      return d;
    });
  }

  private async generateMealPlanWithAI(
    userPreferences: FoodPreferences,
    userProfile: any,
    foodHistorySummary: string
  ): Promise<Omit<MealPlanResult, 'diet_cards'>> {
    
    const userLanguage = userProfile.language || 'en';
    const languageInstruction = LANGUAGE_INSTRUCTIONS[userLanguage as keyof typeof LANGUAGE_INSTRUCTIONS] || LANGUAGE_INSTRUCTIONS.en;
    
    const userNutritionGoals = {
      calories: userProfile.calorieGoal || 2000,
      protein: userProfile.proteinGoal || 125,
      carbs: userProfile.carbsGoal || 225,
      fats: userProfile.fatsGoal || 67
    };

    const userMeasurementSystem = userPreferences.measurementSystem || userProfile.measurementSystem || 'metric';
    const weekDates = this.getCurrentWeekDates();

    // Calculate effective calories per day considering cheat days
    const effectiveCaloriesPerDay: Record<string, number> = {};
    
    if (userPreferences.cheatDays && userPreferences.cheatDays.length > 0) {
      const cheatMap = Object.fromEntries(
        userPreferences.cheatDays.map(cd => [cd.date, cd.calories])
      );
      const cheatCount = userPreferences.cheatDays.length;
      const totalCheatCals = userPreferences.cheatDays.reduce((s, cd) => s + cd.calories, 0);
      const normalDays = weekDates.length - cheatCount;
      const normalDayCals = normalDays > 0 
        ? Math.round((weekDates.length * userNutritionGoals.calories - totalCheatCals) / normalDays)
        : userNutritionGoals.calories;

      weekDates.forEach(d => {
        const dateStr = d.toISOString().split('T')[0];
        effectiveCaloriesPerDay[dateStr] = cheatMap[dateStr] || normalDayCals;
      });
    } else {
      weekDates.forEach(d => {
        const dateStr = d.toISOString().split('T')[0];
        effectiveCaloriesPerDay[dateStr] = userNutritionGoals.calories;
      });
    }

    // Build comprehensive prompt
    const prompt = this.buildMealPlanPrompt(
      userPreferences,
      userProfile,
      userNutritionGoals,
      userMeasurementSystem,
      languageInstruction,
      weekDates,
      effectiveCaloriesPerDay,
      foodHistorySummary
    );

    logger.info('🤖 Calling OpenAI for meal plan generation', { 
      promptLength: prompt.length,
      userLanguage,
      mealsPerDay: userPreferences.mealsPerDay 
    });

    const completion = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are an expert nutritionist and chef. Respond ONLY with the specified JSON structure. Be meticulous with details, especially ingredients, instructions, and the shopping list.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) {
      throw new Error('OpenAI returned no content');
    }

    let aiGeneratedPlan;
    try {
      aiGeneratedPlan = JSON.parse(content);
    } catch (error) {
      const err = error as Error;
      logger.error('Failed to parse OpenAI JSON response', { 
        error: err.message,
        contentPreview: content.substring(0, 500) 
      });
      throw new Error(`Failed to parse AI response: ${err.message}`);
    }

    if (!aiGeneratedPlan.days || !Array.isArray(aiGeneratedPlan.days)) {
      throw new Error('Invalid AI response: missing days array');
    }

    // Post-process days to ensure correct date formatting and calorie targets
    aiGeneratedPlan.days.forEach((day: any, index: number) => {
      const matchingDate = weekDates[index];
      if (matchingDate) {
        const dateStr = matchingDate.toISOString().split('T')[0];
        day.date = dateStr;
        if (effectiveCaloriesPerDay[dateStr]) {
          day.daily_calorie_target = effectiveCaloriesPerDay[dateStr];
        }
      }
    });

    return aiGeneratedPlan;
  }

  private buildMealPlanPrompt(
    userPreferences: FoodPreferences,
    userProfile: any,
    userNutritionGoals: any,
    userMeasurementSystem: string,
    languageInstruction: string,
    weekDates: Date[],
    effectiveCaloriesPerDay: Record<string, number>,
    foodHistorySummary: string
  ): string {

    let dailyCalorieInstructions = '\nDAILY CALORIE TARGETS (approximate):';
    weekDates.forEach(d => {
      const dateStr = d.toISOString().split('T')[0];
      dailyCalorieInstructions += `\n- ${dateStr}: ${effectiveCaloriesPerDay[dateStr]} kcal`;
    });
    dailyCalorieInstructions += '\nSum of meal calories for each day should closely match its daily target. Weekly average should align with user\'s overall goal. Macronutrients should be proportionally distributed.';

    let allergyInstruction = '';
    if (userPreferences.allergies && userPreferences.allergies.length > 0) {
      allergyInstruction = `\nCRITICAL ALLERGY WARNING: The user is allergic to: ${userPreferences.allergies.join(', ')}. ABSOLUTELY DO NOT include these ingredients or any of their derivatives in ANY meal. THIS IS A NON-NEGOTIABLE HEALTH REQUIREMENT.`;
    }

    let dislikedInstruction = '';
    if (userPreferences.dislikedIngredients && userPreferences.dislikedIngredients.length > 0) {
      dislikedInstruction = `\nAVOID DISLIKED INGREDIENTS: Strictly avoid these: ${userPreferences.dislikedIngredients.join(', ')}.`;
    }

    let cheatDayInfoForPrompt = "\nThis plan is for 7 days.";
    const cheatDayDates = userPreferences.cheatDays?.map(cd => cd.date) || [];
    if (cheatDayDates.length > 0) {
      cheatDayInfoForPrompt = `\nCHEAT DAYS: The following dates are cheat days: ${cheatDayDates.join(', ')}. For these cheat days, DO NOT generate any meals or recipes. Simply acknowledge them in the plan structure if necessary (e.g., mark as "User's Choice" or similar for that day with target calories), but focus meal generation on non-cheat days. The daily calorie target for a cheat day is specified in the 'DAILY CALORIE TARGETS' section.`;
    }

    // Build meal structure instruction
    let mealStructureInstruction = '';
    if (userPreferences.mealsPerDay === 1) {
      mealStructureInstruction = 'provide 1 main meal per day (typically a large, nutritionally complete meal)';
    } else if (userPreferences.mealsPerDay === 2) {
      mealStructureInstruction = 'provide exactly 2 meals per day. For 2-meal days, use either: (1) Breakfast and Dinner (intermittent fasting style), or (2) Lunch and Dinner (skip breakfast). Make each meal substantial to meet daily calorie targets';
    } else if (userPreferences.mealsPerDay === 3) {
      mealStructureInstruction = 'provide exactly 3 meals per day (breakfast, lunch, and dinner)';
    } else if (userPreferences.mealsPerDay === 4) {
      mealStructureInstruction = 'provide exactly 4 meals per day (breakfast, lunch, dinner, and 1 snack)';
    } else if (userPreferences.mealsPerDay === 5) {
      mealStructureInstruction = 'provide exactly 5 meals per day (breakfast, lunch, dinner, and 2 snacks)';
    } else if (userPreferences.mealsPerDay >= 6) {
      mealStructureInstruction = `provide exactly ${userPreferences.mealsPerDay} meals per day (breakfast, lunch, dinner, and ${userPreferences.mealsPerDay - 3} snacks)`;
    } else {
      mealStructureInstruction = 'provide exactly 3 meals per day (breakfast, lunch, and dinner)';
    }

    return `
You are an expert nutritionist and chef creating a 7-day personalized meal plan.

LANGUAGE INSTRUCTION: ${languageInstruction}

The user's preferred measurement system is: ${userMeasurementSystem}. Provide all ingredient quantities in this system.

${allergyInstruction}
${dislikedInstruction}
${cheatDayInfoForPrompt}

User Profile & Preferences:
- Goal: ${userPreferences.goal || userProfile.goal || 'maintain health'}
- Dietary Restrictions: ${userPreferences.dietaryRestrictions?.join(', ') || 'None'}
- Diet Types: ${(userPreferences.dietTypes || []).join(', ') || 'None'}
- Cuisine Preferences: ${userPreferences.cuisinePreferences?.join(', ') || 'None'}
- Liked Ingredients: ${userPreferences.likedIngredients?.join(', ') || 'None'}
- Meals Per Day: ${userPreferences.mealsPerDay} (if >3, include healthy snacks)
- Budget: ${userPreferences.budget || 'moderate'}
- Cooking Skill: ${userPreferences.cookingSkill || 'intermediate'}
- Spice Level: ${userPreferences.spiceLevel || 'medium'}
- Cooking Time: ${userPreferences.cookingTime || 'moderate'} per main meal
- Favorite Dishes: ${userPreferences.favoriteDishes?.join(', ') || 'None'} (consider incorporating these or similar styles)
- Repeat Meals: ${userPreferences.allowMealRepeats === false ? 'Do NOT repeat meals. Each meal should be unique.' : 'Meals may repeat if it makes sense for the plan.'}

User's Average Daily Nutrition Goals (for overall weekly balance):
- Calories: ${userNutritionGoals.calories} kcal
- Protein: ${userNutritionGoals.protein}g
- Carbs: ${userNutritionGoals.carbs}g
- Fats: ${userNutritionGoals.fats}g

${dailyCalorieInstructions}

Recent Eating Behavior (for context, aim for variety and improvement):
${foodHistorySummary}

CRITICAL: IMAGE KEYWORDS GUIDANCE
Each meal MUST have visually-focused keywords for finding appealing food photos. The first keyword should be the most visually prominent ingredient or dish element. Good images are crucial for user engagement.

Examples of GOOD vs BAD keywords:
✅ GOOD: "Grilled Salmon with Quinoa" → ["grilled salmon", "quinoa", "fish"]
❌ BAD: ["healthy", "protein", "dinner"]

✅ GOOD: "Sweet Potato Hash with Eggs" → ["sweet potato", "hash browns", "eggs"]  
❌ BAD: ["breakfast", "healthy", "nutritious"]

✅ GOOD: "Chicken Caesar Salad" → ["caesar salad", "grilled chicken", "romaine"]
❌ BAD: ["salad", "lunch", "greens"]

INSTRUCTIONS FOR MEAL PLAN GENERATION:
For each of the 7 days (${weekDates.map(d => d.toISOString().split('T')[0]).join(', ')}):
- If it's a cheat day (as listed above), structure the day as a cheat day with the specified calorie target. Do not list specific meals unless it's a generic "User's Choice" placeholder.
- For non-cheat days, ${mealStructureInstruction}. CRITICAL: You must provide exactly ${userPreferences.mealsPerDay} meals per day, no more, no less.
- For EACH meal on non-cheat days, YOU MUST provide:
  1. "type": (e.g., "Breakfast", "Lunch", "Dinner", "Snack")
  2. "name": (e.g., "Mediterranean Quinoa Salad with Grilled Chicken")
  3. "englishName": (Same as name, or English translation if applicable)
  4. "description": (A brief, appetizing description of the meal)
  5. "image_search_keywords": ["main_ingredient", "cooking_method", "dish_style"] (CRITICAL: Choose 1-3 keywords that best represent the VISUAL appearance of the dish. Focus on the most prominent ingredient or visual element. Examples: "Sweet Potato Hash with Eggs" → ["sweet potato", "hash", "breakfast"], "Grilled Chicken Wrap" → ["grilled chicken", "wrap", "tortilla"], "Tofu Stir Fry with Brown Rice" → ["tofu", "stir fry", "vegetables"], "Carrot Sticks with Hummus" → ["carrot sticks", "hummus", "dip"]. Avoid generic terms like "healthy" or "delicious.")
  6. "nutritionalInfo": { "calories": number, "protein": number, "carbs": number, "fats": number } (estimated for the serving)
  7. "ingredients": ["quantity unit ingredient (e.g., 150g chicken breast)", "1 tbsp olive oil", "50g quinoa (uncooked)"] (COMPLETE list including oils, spices, garnishes. Use ${userMeasurementSystem} units.)
  8. "instructions": ["Step 1: ...", "Step 2: ..."] (DETAILED, step-by-step, clear, and actionable cooking instructions)
  9. "preparationTime": (e.g., "Approx. 30 minutes")
  10. "portionSize": (e.g., "1 serving", or specify weight/volume based on ingredients)

SHOPPING LIST:
After all days, provide a "shopping_list". This list should:
- Be consolidated for the entire week.
- Group items by common grocery store categories (e.g., "Produce", "Protein", "Dairy & Alternatives", "Pantry", "Spices & Oils", "Grains & Bakery").
- For each item, specify: "name", "quantity_needed_for_week" (e.g., "Chicken Breast", "600g total" or "3 medium onions"), and its "category".
- Be smart about quantities (e.g., if 3 recipes use onion, list total onion needed, not onion three times). Avoid listing water, basic salt, pepper unless a specific type/amount is critical.

RECOMMENDATIONS & GUIDELINES:
Provide general "recommendations" (meal timing, food categories to focus on/limit) and "guidelines" (hydration, mindful eating tips).

OUTPUT STRUCTURE (Strictly JSON):
{
  "overview": {
    "goal": "User's primary goal",
    "average_calorie_target": ${userNutritionGoals.calories},
    "average_protein_target": ${userNutritionGoals.protein},
    "average_carbs_target": ${userNutritionGoals.carbs},
    "average_fats_target": ${userNutritionGoals.fats},
    "summary": "Brief overview of the plan's approach.",
    "measurement_system_used": "${userMeasurementSystem}"
  },
  "days": [
    {
      "day": "Monday", "date": "YYYY-MM-DD", "daily_calorie_target": number, "isCheatDay": boolean,
      "meals": [ /* array of meal objects as specified above, or specific cheat day structure */ ],
      "daily_totals": { "calories": number, "protein": number, "carbs": number, "fats": number } // Sum for the day
    }
    // ... (for all 7 days)
  ],
  "shopping_list": [
    { "category": "Produce", "items": [ { "name": "Spinach", "quantity_needed_for_week": "200g bag" }, {"name": "Onion", "quantity_needed_for_week": "3 medium"} ] },
    { "category": "Protein", "items": [ { "name": "Chicken Breast", "quantity_needed_for_week": "600g total" } ] }
    // ... other categories and items
  ],
  "recommendations": {
    "meal_timing_suggestions": ["Breakfast: 7-9 AM", ...],
    "food_categories": { "recommended": [...], "limit": [...], "avoid": ["User's allergens automatically included here", ...${JSON.stringify(userPreferences.allergies || [])}] }
  },
  "guidelines": [ { "title": "Stay Hydrated", "description": "Drink water.", "action_items": ["Carry bottle"] } ]
}
Ensure all nutritional information is as accurate as possible. Ensure daily totals for calories and macros are calculated and match the sum of meals for that day (for non-cheat days).
For cheat days, the "meals" array might be empty or contain a single placeholder object like {"type": "Cheat Day", "name": "User's Choice", "description": "Enjoy your favorite meal within the calorie target!"}, and daily_totals should reflect the cheat day's calorie target.
`;
  }

  private async fetchMealImages(mealPlan: any): Promise<void> {
    if (!mealPlan.days || !Array.isArray(mealPlan.days)) return;

    logger.info('🖼️ Fetching meal images', { dayCount: mealPlan.days.length });

    for (const [dayIndex, day] of mealPlan.days.entries()) {
      if (day.isCheatDay) {
        // Handle cheat day images
        if (day.meals && Array.isArray(day.meals)) {
          for (const meal of day.meals) {
            if (meal.type === "Cheat Day") {
              try {
                meal.image = await this.getMealImageUrl("Celebration feast gourmet", "Cheat Meal", ["celebration", "feast", "indulgent food"]);
              } catch (error) {
                logger.warn('Failed to get cheat day image', { error });
                meal.image = 'https://images.unsplash.com/photo-1576402187878-974f70c890a5?q=80&w=800&auto=format&fit=crop';
              }
            }
          }
        }
        continue;
      }

      if (day.meals && Array.isArray(day.meals)) {
        for (const [mealIndex, meal] of day.meals.entries()) {
          if (meal.name && meal.type) {
            try {
              logger.debug(`Fetching image for meal: ${meal.name}`, { 
                dayIndex: dayIndex + 1, 
                mealIndex: mealIndex + 1 
              });
              meal.image = await this.getMealImageUrl(meal.name, meal.type, meal.image_search_keywords);
            } catch (error) {
              logger.warn(`Failed to get image for meal ${meal.name}`, { error });
              // Provide fallback image based on meal type
              const fallbackImages: Record<string, string> = {
                'Breakfast': 'https://images.unsplash.com/photo-1533089860892-a7c6f0a88666?q=80&w=800&auto=format&fit=crop',
                'Lunch': 'https://images.unsplash.com/photo-1547496502-affa22d38842?q=80&w=800&auto=format&fit=crop',
                'Dinner': 'https://images.unsplash.com/photo-1576402187878-974f70c890a5?q=80&w=800&auto=format&fit=crop',
                'Snack': 'https://images.unsplash.com/photo-1482049016688-2d3e1b311543?q=80&w=800&auto=format&fit=crop'
              };
              meal.image = fallbackImages[meal.type] || 'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?q=80&w=800&auto=format&fit=crop';
            }
          }
        }
      }
    }
  }

  private async getMealImageUrl(mealName: string, mealType: string, aiKeywords: string[] = []): Promise<string> {
    const genericFoodImage = 'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?q=80&w=800&auto=format&fit=crop';
    const defaultImagesByType: Record<string, string> = {
      'Breakfast': 'https://images.unsplash.com/photo-1533089860892-a7c6f0a88666?q=80&w=800&auto=format&fit=crop',
      'Lunch': 'https://images.unsplash.com/photo-1547496502-affa22d38842?q=80&w=800&auto=format&fit=crop',
      'Dinner': 'https://images.unsplash.com/photo-1576402187878-974f70c890a5?q=80&w=800&auto=format&fit=crop',
      'Snack': 'https://images.unsplash.com/photo-1482049016688-2d3e1b311543?q=80&w=800&auto=format&fit=crop'
    };

    if (!this.unsplashAccessKey) {
      logger.warn(`No Unsplash access key, using fallback for: ${mealName}`);
      return defaultImagesByType[mealType] || genericFoodImage;
    }

    try {
      // Simple implementation - just use the first keyword for search
      const searchTerm = aiKeywords?.[0] || mealName.split(' ').slice(0, 2).join(' ');
      const searchQuery = `${searchTerm} food dish`;

      const response = await fetch(`https://api.unsplash.com/search/photos?query=${encodeURIComponent(searchQuery)}&per_page=5&orientation=landscape&content_filter=high&client_id=${this.unsplashAccessKey}`);
      
      if (!response.ok) {
        throw new Error(`Unsplash API error: ${response.status}`);
      }

      const data = await response.json() as any;
      
      if (data.results && data.results.length > 0) {
        // Find an image we haven't used yet
        for (const image of data.results) {
          if (image.urls?.regular && !usedImageUrls.has(image.urls.regular)) {
            usedImageUrls.add(image.urls.regular);
            return image.urls.regular;
          }
        }
      }

      // If no unique images found, use fallback
      return defaultImagesByType[mealType] || genericFoodImage;

    } catch (error) {
      const err = error as Error;
      logger.warn(`Failed to fetch image from Unsplash for ${mealName}`, { error: err.message });
      return defaultImagesByType[mealType] || genericFoodImage;
    }
  }

  private async generateDietCards(
    userPreferences: FoodPreferences,
    foodHistorySummary: string,
    userLanguage: string
  ) {
    const languageInstruction = LANGUAGE_INSTRUCTIONS[userLanguage as keyof typeof LANGUAGE_INSTRUCTIONS] || LANGUAGE_INSTRUCTIONS.en;
    
    const dietCardsPrompt = `${languageInstruction} Analyze food history: ${foodHistorySummary} Generate 3-5 actionable improvement tips as JSON array of objects [{title, description, icon}]. Concise. Goal: ${userPreferences.goal || 'maintaining health'}. Icons ONLY from: 'food-apple', 'food-steak', 'tea', 'water', 'dumbbell', 'leaf', 'silverware', 'clock-outline', 'fire', 'fish', 'heart-pulse', 'rice', 'bread-slice', 'meditation', 'run-fast', 'sleep', 'clock-time-eight', 'scale-bathroom', 'pot-steam', 'oil', 'baguette', 'carrot', 'cupcake', 'weight-lifter', 'apple', 'lightbulb', 'food-variant', 'nutrition', 'chart-line', 'water-outline', 'food-drumstick', 'egg', 'food-croissant', 'glass-wine', 'food-off', 'timer-outline', 'calendar-check', 'target'. Example: [{"title": "More Protein", "description": "Add chicken to lunch.", "icon": "food-steak"}]`;

    try {
      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `Expert nutritionist. ${languageInstruction} Respond ONLY with JSON array. Icons strictly from list.`
          },
          {
            role: 'user',
            content: dietCardsPrompt
          }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2
      });

      const dietCardsContent = completion.choices[0]?.message?.content;
      if (dietCardsContent) {
        let parsedCards = JSON.parse(dietCardsContent);
        if (Array.isArray(parsedCards)) {
          return parsedCards;
        } else if (parsedCards && typeof parsedCards === 'object' && Object.values(parsedCards).some(Array.isArray)) {
          return Object.values(parsedCards).find(Array.isArray) || [];
        }
      }
      return [];
    } catch (error) {
      const err = error as Error;
      logger.error('Error generating diet cards', { error: err.message });
      return [];
    }
  }
}