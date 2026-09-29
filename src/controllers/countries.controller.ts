import { Request, Response } from 'express';
import { catchAsync } from '../utils/catchAsync.js';
import { pick } from '../utils/pick.js';
import * as countryService from '../services/countries.service.js';

export const listCountries = catchAsync(async (req: Request, res: Response) => {
  const filter = pick(req.query, ['search']);
  const options = pick(req.query, ['sort_by', 'limit', 'page']);
  const result = await countryService.listCountries(filter, options);
  res.status(result.status).json(result);
});
