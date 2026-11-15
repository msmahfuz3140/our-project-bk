import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { logger } from '../utils/logger';

export const ContactSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters long'),
  email: z.string().email('Please provide a valid email address'),
  subject: z.string().min(3, 'Subject must be at least 3 characters long'),
  message: z.string().min(10, 'Message must be at least 10 characters long')
});

export class ContactController {
  async submitInquiry(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const validated = ContactSchema.parse(req.body);
      logger.info('Support inquiry received', {
        name: validated.name,
        email: validated.email,
        subject: validated.subject,
        ip: req.ip
      });

      res.status(200).json({
        success: true,
        message: 'Your inquiry has been received. Our support team will review your message and reply via email within 24 hours.'
      });
    } catch (error) {
      next(error);
    }
  }
}

export const contactController = new ContactController();
