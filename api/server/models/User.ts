import * as _ from 'lodash';
import * as mongoose from 'mongoose';

import { fieldEncryption } from 'mongoose-field-encryption';
import sendEmail from '../aws-ses';
import logger from '../logs';
import { subscribe } from '../mailchimp';
import { generateSlug } from '../utils/slugify';
import getEmailTemplate, { EmailTemplate } from './EmailTemplate';
import Invitation from './Invitation';
import Team from './Team';

import {
  createCustomer,
  createNewCard,
  getListOfInvoices,
  retrieveCard,
  updateCustomer,
} from '../stripe';

import {
  EMAIL_SUPPORT_FROM_ADDRESS, ENCRYPT_SECRET,
  GOOGLE_CLIENTID, MICROSOFT_CLIENTID,
} from '../consts';

mongoose.set('useFindAndModify', false);

const mongoSchema = new mongoose.Schema({
  googleId: {
    type: String,
    unique: true,
    sparse: true,
  },
  microsoftId: {
    type: String,
    unique: true,
    sparse: true,
  },
  oAuthAccessToken: {
    type: Map,
    of: String,
    default: undefined,
  },
  oAuthRefreshToken: {
    type: Map,
    of: String,
    default: undefined,
  },
  slug: {
    type: String,
    required: true,
    unique: true,
  },
  createdAt: {
    type: Date,
    required: true,
  },
  email: {
    type: String,
    required: true,
    unique: true,
  },

  defaultTeamSlug: {
    type: String,
    default: '',
  },

  isAdmin: {
    type: Boolean,
    default: false,
  },
  displayName: String,
  avatarUrl: String,

  stripeCustomer: {
    id: String,
    object: String,
    created: Number,
    currency: String,
    default_source: String,
    description: String,
  },
  stripeCard: {
    id: String,
    object: String,
    brand: String,
    funding: String,
    country: String,
    last4: String,
    exp_month: Number,
    exp_year: Number,
  },
  hasCardInformation: {
    type: Boolean,
    default: false,
  },
  stripeListOfInvoices: {
    object: String,
    has_more: Boolean,
    data: [
      {
        id: String,
        object: String,
        amount_paid: Number,
        date: Number,
        customer: String,
        subscription: String,
        hosted_invoice_url: String,
        billing: String,
        paid: Boolean,
        number: String,
        teamId: String,
        teamName: String,
      },
    ],
  },
  darkTheme: Boolean,
});

export interface IUserDocument extends mongoose.Document {
  googleId?: string;
  microsoftId?: string;
  oAuthAccessToken?: [Map<string, string>];
  oAuthRefreshToken?: [Map<string, string>];
  slug: string;
  createdAt: Date;

  email: string;
  isAdmin: boolean;
  displayName: string;
  avatarUrl: string;

  defaultTeamSlug: string;

  hasCardInformation: boolean;
  stripeCustomer: {
    id: string;
    default_source: string;
    created: number;
    object: string;
    description: string;
  };
  stripeCard: {
    id: string;
    object: string;
    brand: string;
    country: string;
    last4: string;
    exp_month: number;
    exp_year: number;
    funding: string;
  };
  stripeListOfInvoices: {
    object: string;
    has_more: boolean;
    data: [
      {
        id: string;
        object: string;
        amount_paid: number;
        date: number;
        customer: string;
        subscription: string;
        hosted_invoice_url: string;
        billing: string;
        paid: boolean;
        number: string;
        teamId: string;
        teamName: string;
      }
    ];
  };
  darkTheme: boolean;
  decryptFieldsSync(): void;
  encryptFieldsSync(): void;
  stripEncryptionFieldMarkers(): void;
}

interface IUserModel extends mongoose.Model<IUserDocument> {
  publicFields(): string[];
  oAuthFields(): string[];
  updateProfile({
    userId,
    name,
    avatarUrl,
  }: {
    userId: string;
    name: string;
    avatarUrl: string;
  }): Promise<IUserDocument[]>;

  getTeamMembers({ userId, teamId }: { userId: string; teamId: string }): Promise<IUserDocument[]>;

  signInOrSignUp(type: string, {
    oauthId,
    email,
    oauthToken,
    displayName,
    avatarUrl,
  }: {
    oauthId: string;
    email: string;
    displayName: string;
    avatarUrl: string;
    oauthToken: { refreshToken?: string; accessToken?: string };
  }): Promise<IUserDocument>;

  signUpByEmail({ uid, email }: { uid: string; email: string }): Promise<IUserDocument>;

  createCustomer({
    userId,
    stripeToken,
  }: {
    userId: string;
    stripeToken: object;
  }): Promise<IUserDocument>;

  createNewCardUpdateCustomer({
    userId,
    stripeToken,
  }: {
    userId: string;
    stripeToken: object;
  }): Promise<IUserDocument>;
  getListOfInvoicesForCustomer({ userId }: { userId: string }): Promise<IUserDocument>;
  toggleTheme({ userId, darkTheme }: { userId: string; darkTheme: boolean }): Promise<void>;
}

class UserClass extends mongoose.Model {
  public static async updateProfile({ userId, name, avatarUrl }) {
    // TODO: If avatarUrl is changed and old is uploaded to our S3, delete it from S3

    const user = await this.findById(userId, 'slug displayName');

    const modifier = { displayName: user.displayName, avatarUrl, slug: user.slug };

    if (name !== user.displayName) {
      modifier.displayName = name;
      modifier.slug = await generateSlug(this, name);
    }

    return this.findByIdAndUpdate(userId, { $set: modifier }, { new: true, runValidators: true })
      .select('displayName avatarUrl slug')
      .setOptions({ lean: true });
  }

  public static async createCustomer({ userId, stripeToken }) {
    const user = await this.findById(userId, 'email');

    const customerObj = await createCustomer({
      token: stripeToken.id,
      teamLeaderEmail: user.email,
      teamLeaderId: userId,
    });

    logger.debug(customerObj.default_source.toString());

    const cardObj = await retrieveCard({
      customerId: customerObj.id,
      cardId: customerObj.default_source.toString(),
    });

    const modifier = { stripeCustomer: customerObj, stripeCard: cardObj, hasCardInformation: true };

    return this.findByIdAndUpdate(userId, { $set: modifier }, { new: true, runValidators: true })
      .select('stripeCustomer stripeCard hasCardInformation')
      .setOptions({ lean: true });
  }

  public static async createNewCardUpdateCustomer({ userId, stripeToken }) {
    const user = await this.findById(userId, 'stripeCustomer');

    logger.debug('called static method on User');

    const newCardObj = await createNewCard({
      customerId: user.stripeCustomer.id,
      token: stripeToken.id,
    });

    logger.debug(newCardObj.id);

    const updatedCustomerObj = await updateCustomer({
      customerId: user.stripeCustomer.id,
      newCardId: newCardObj.id,
    });

    const modifier = { stripeCustomer: updatedCustomerObj, stripeCard: newCardObj };

    return this.findByIdAndUpdate(userId, { $set: modifier }, { new: true, runValidators: true })
      .select('stripeCard')
      .setOptions({ lean: true });
  }

  public static async getListOfInvoicesForCustomer({ userId }) {
    const user = await this.findById(userId, 'stripeCustomer');

    logger.debug('called static method on User');

    const newListOfInvoices = await getListOfInvoices({
      customerId: user.stripeCustomer.id,
    });

    const modifier = {
      stripeListOfInvoices: newListOfInvoices,
    };

    if (!newListOfInvoices) {
      throw new Error('There is no payment history.');
    }

    return this.findByIdAndUpdate(userId, { $set: modifier }, { new: true, runValidators: true })
      .select('stripeListOfInvoices')
      .setOptions({ lean: true });
  }

  public static async getTeamMembers({ userId, teamId }) {
    const team = await this.checkPermissionAndGetTeam({ userId, teamId });

    return this.find({ _id: { $in: team.memberIds } })
      .select(this.publicFields().join(' '))
      .setOptions({ lean: true });
  }

  public static async signInOrSignUp(type: string, { oauthId, email, oauthToken, displayName, avatarUrl }) {

    if (!oauthId) {
      throw new Error('oauthId is required');
    }
    const oAuthFields = {
      Id: `${type}Id`,
      AccessToken: `oAuthAccessToken.${type}`,
      RefreshToken: `oAuthRefreshToken.${type}`,
    };

    // email is a unique constraint on the UserSchema
    // if a user already exists with the same email it
    // attaches this oAuth account to it instead of creating a new account.
    // can't be a lean query, or have projections, cause we need the tokens unencrypted here.
    const user = await this.findOne({
      $or: [
        { email },
        { [oAuthFields.Id]: oauthId },
      ],
    });

    if (user) {

      if (_.isEmpty(oauthToken)) {
        return user;
      }
      if (!user.get(oAuthFields.Id)) {
        user.set(oAuthFields.Id, oauthId);
      }

      if (oauthToken.accessToken) {
        user.set(oAuthFields.AccessToken, oauthToken.accessToken);
        user.__enc_oAuthAccessToken = false; // trigger new encryption
      }

      if (oauthToken.refreshToken) {
        user.set(oAuthFields.RefreshToken, oauthToken.refreshToken);
        user.__enc_oAuthRefreshToken = false; // trigger new encryption
      }

      await user.save();
      user.decryptFieldsSync();
      user.stripEncryptionFieldMarkers();
      return user;
    }

    const slug = await generateSlug(this, displayName);

    const newUser = new User({
      createdAt: new Date(),
      email,
      displayName,
      avatarUrl,
      slug,
      defaultTeamSlug: '',
    });

    newUser.set(oAuthFields.Id, oauthId);

    if (oauthToken.accessToken) {
      newUser.set(oAuthFields.AccessToken, oauthToken.accessToken);
    }

    if (oauthToken.refreshToken) {
      newUser.set(oAuthFields.RefreshToken, oauthToken.refreshToken);
    }

    await newUser.save();

    const hasInvitation = (await Invitation.countDocuments({ email })) > 0;

    const emailTemplate = await EmailTemplate.findOne({ name: 'welcome' }).setOptions({
      lean: true,
    });

    if (!emailTemplate) {
      throw new Error('welcome Email template not found');
    }

    const template = await getEmailTemplate('welcome', { userName: displayName }, emailTemplate);

    if (!hasInvitation) {
      try {
        await sendEmail({
          from: `Kelly from async-await.com <${EMAIL_SUPPORT_FROM_ADDRESS}>`,
          to: [email],
          subject: template.subject,
          body: template.message,
        });
      } catch (err) {
        logger.error('Email sending error:', err);
      }
    }

    try {
      await subscribe({ email, listName: 'signups' });
    } catch (error) {
      logger.error('Mailchimp error:', error);
    }

    // return the oauth fields but without the tokens
    newUser.decryptFieldsSync();
    newUser.stripEncryptionFieldMarkers();
    return newUser;
  }

  public static async signUpByEmail({ uid, email }) {
    const user = await this.findOne({ email })
      .select(this.publicFields().join(' '))
      .setOptions({ lean: true });

    if (user) {
      throw Error('User already exists');
    }

    const slug = await generateSlug(this, email);

    const newUser = await this.create({
      _id: uid,
      createdAt: new Date(),
      email,
      slug,
      defaultTeamSlug: '',
    });

    const hasInvitation = (await Invitation.countDocuments({ email })) > 0;

    const emailTemplate = await EmailTemplate.findOne({ name: 'welcome' }).setOptions({
      lean: true,
    });

    if (!emailTemplate) {
      throw new Error('welcome Email template not found');
    }

    const template = await getEmailTemplate('welcome', { userName: email }, emailTemplate);

    if (!hasInvitation) {
      try {
        await sendEmail({
          from: `Kelly from async-await.com <${EMAIL_SUPPORT_FROM_ADDRESS}>`,
          to: [email],
          subject: template.subject,
          body: template.message,
        });
      } catch (err) {
        logger.error('Email sending error:', err);
      }
    }

    try {
      await subscribe({ email, listName: 'signups' });
    } catch (error) {
      logger.error('Mailchimp error:', error);
    }

    return _.pick(newUser, this.publicFields());
  }

  public static publicFields(): string[] {
    return [
      '_id',
      'id',
      'displayName',
      'email',
      'avatarUrl',
      'slug',
      'isMicrosoftUser',
      'isGoogleUser',
      'defaultTeamSlug',
      'hasCardInformation',
      'stripeCustomer',
      'stripeCard',
      'stripeListOfInvoices',
      'darkTheme',
    ];
  }
  public static oAuthFields(): string[] {
    const fields = this.publicFields();
    if (MICROSOFT_CLIENTID) {
      fields.push('microsoftId');
    }
    if (GOOGLE_CLIENTID) {
      fields.push('googleId');
    }
    return fields;
  }
  public static async checkPermissionAndGetTeam({ userId, teamId }) {
    if (!userId || !teamId) {
      throw new Error('Bad data');
    }

    const team = await Team.findById(teamId)
      .select('memberIds')
      .setOptions({ lean: true });

    if (!team || team.memberIds.indexOf(userId) === -1) {
      throw new Error('Team not found');
    }

    return team;
  }

  public static toggleTheme({ userId, darkTheme }) {
    return this.updateOne({ _id: userId }, { darkTheme: !!darkTheme });
  }
}

if (GOOGLE_CLIENTID || MICROSOFT_CLIENTID) {
  // set virtual to be exported to APP (via JSON endpoints)
  mongoSchema.set('toJSON', { virtuals: true });
  if (MICROSOFT_CLIENTID) {
    mongoSchema.virtual('isMicrosoftUser').get(function(this: IUserDocument) {
      return this.microsoftId && this.microsoftId.length > 0;
    });
  }
  if (GOOGLE_CLIENTID) {
    mongoSchema.virtual('isGoogleUser').get(function(this: IUserDocument) {
      return this.googleId && this.googleId.length > 0;
    });
  }
  // setup field encryption
  mongoSchema.plugin(fieldEncryption, {
    fields: ['oAuthAccessToken', 'oAuthRefreshToken'], secret: ENCRYPT_SECRET,
  });
}
mongoSchema.loadClass(UserClass);

const User = mongoose.model<IUserDocument, IUserModel>('User', mongoSchema);
User.ensureIndexes(err => {
  if (err) {
    logger.error(`User.ensureIndexes: ${err.stack}`);
  }
});

export default User;
