import { Schema } from 'mongoose';

const deleteAtPath = (
  obj: Record<string, any>,
  path: string[],
  index: number,
) => {
  if (index === path.length - 1) {
    const key = path[index];
    if (key) delete obj[key];
    return;
  }
  const key = path[index];
  if (key && obj[key]) {
    deleteAtPath(obj[key], path, index + 1);
  }
};

export const toJSON = (schema: Schema) => {
  const originalTransform = schema.options.toJSON?.transform;
  const paths = schema.paths as any;

  schema.options.toJSON = Object.assign({}, schema.options.toJSON, {
    transform(doc: any, ret: any, options: any) {
      Object.keys(paths).forEach((path: string) => {
        const pathOptions = paths[path].options;
        if (pathOptions?.private) {
          deleteAtPath(ret, path.split('.'), 0);
        }
      });

      if (ret._id) {
        ret.id = ret._id.toString();
      }
      delete ret._id;
      delete ret.__v;
      if (typeof originalTransform === 'function') {
        return originalTransform(doc, ret, options);
      }
    },
  });
};
