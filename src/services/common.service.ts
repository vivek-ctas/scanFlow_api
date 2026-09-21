export const createResponse = (
  statusCode: number,
  message: string,
  data?: any,
) => {
  if (data !== undefined) {
    return { status: statusCode, message, data };
  }
  return { status: statusCode, message };
};
