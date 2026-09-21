import mongoose, { Model } from 'mongoose';

let globalSystemErrorModel: Model<any> | null = null;

export const setSystemErrorModel = (model: Model<any>) => {
  globalSystemErrorModel = model;
};

const serializeErrorData = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }

  const seen = new WeakSet();

  try {
    return JSON.stringify(value, (_key, currentValue) => {
      if (currentValue instanceof Error) {
        return {
          name: currentValue.name,
          message: currentValue.message,
          stack: currentValue.stack,
        };
      }

      if (typeof currentValue === 'object' && currentValue !== null) {
        if (seen.has(currentValue)) {
          return '[Circular]';
        }
        seen.add(currentValue);
      }

      return currentValue;
    });
  } catch {
    return String(value);
  }
};

export const errorHandler = {
  errorM: async (data: { action_type: string; error_data: unknown }) => {
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
        error_data: serializeErrorData(data.error_data),
      });
    } catch (error) {
      console.error('Failed to save system error to database:', error);
    }
  },
};
