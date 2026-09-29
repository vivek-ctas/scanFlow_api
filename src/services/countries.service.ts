import httpStatus from 'http-status';
import { Country } from '../models/country.model.js';
import { createResponse, escapeRegExp } from './common.service.js';

export const listCountries = async (
  filter: Record<string, any>,
  options: Record<string, any>,
) => {
  const query: Record<string, any> = {};
  if (filter.search) {
    const regex = new RegExp(escapeRegExp(String(filter.search)), 'i');
    query.$or = [{ country_name: regex }, { country_code: regex }];
  }

  const countries = await (Country as any).paginate(query, {
    sort_by: options.sort_by ?? 'country_name:asc',
    limit: options.limit ?? 250,
    page: options.page ?? 1,
  });
  return createResponse(httpStatus.OK, 'Countries fetched successfully.', {
    results: countries.results,
    page: countries.page,
    limit: countries.limit,
    total_pages: countries.total_pages,
    total_results: countries.total_results,
  });
};
