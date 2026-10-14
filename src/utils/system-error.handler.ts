import { Model } from 'mongoose';
import { scrubSensitiveText } from './dashboard-scrub.js';

let globalSystemErrorModel: Model<any> | null = null;

export const setSystemErrorModel = (model: Model<any>) => {
  globalSystemErrorModel = model;
};

export const errorHandler = {
  errorM: async (data: {
    action_type: string;
    error_data: unknown;
    method?: string;
    route?: string;
    status_code?: number;
  }) => {
    try {
      if (!globalSystemErrorModel) {
        console.error(
          `[ErrorHandler] Action: ${data.action_type}`,
          data.error_data,
        );
        return;
      }

      await globalSystemErrorModel.create({
        action_type: data.action_type,
        error_data: scrubSensitiveText(data.error_data),
        method: data.method,
        route: data.route,
        status_code: data.status_code,
      });
    } catch (error) {
      console.error('Failed to save system error to database:', error);
    }
  },
};
