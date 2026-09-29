import { Router } from 'express';
import { validate } from '../middlewares/validate.js';
import * as validation from '../validations/countries.validations.js';
import * as controller from '../controllers/countries.controller.js';

const router = Router();

router
  .route('/')
  .get(validate(validation.listCountries), controller.listCountries);

export const countriesRouter = router;
