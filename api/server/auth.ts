import * as passport from 'passport';
import { OAuth2Strategy as GoogleStrategy } from 'passport-google-oauth';
import { Strategy as MicrosoftStrategy } from 'passport-microsoft';
import * as passwordless from 'passwordless';

import sendEmail from './aws-ses';
import logger from './logs';
import getEmailTemplate from './models/EmailTemplate';
import Invitation from './models/Invitation';
import User, { IUserDocument } from './models/User';
import PasswordlessMongoStore from './passwordless';

import {
  AZURE_CLIENTID, AZURE_CLIENTSECRET,
  EMAIL_SUPPORT_FROM_ADDRESS, GOOGLE_CLIENTID,
  GOOGLE_CLIENTSECRET, MICROSOFT_CLIENTID,
  MICROSOFT_CLIENTSECRET, URL_APP,
} from './consts';

function setupPasswordless({ server, ROOT_URL }) {
  const mongoStore = new PasswordlessMongoStore();
  passwordless.init(mongoStore);

  passwordless.addDelivery(async (tokenToSend, uidToSend, recipient, callback) => {
    try {
      const template = await getEmailTemplate('login', {
        loginURL: `${ROOT_URL}/auth/logged_in?token=${tokenToSend}&uid=${encodeURIComponent(
          uidToSend,
        )}`,
      });

      logger.debug(template.message);

      await sendEmail({
        from: `Kelly from async-await.com <${EMAIL_SUPPORT_FROM_ADDRESS}>`,
        to: [recipient],
        subject: template.subject,
        body: template.message,
      });

      callback();
    } catch (err) {
      logger.error('Email sending error:', err);
      callback(err);
    }
  });

  server.use(passwordless.sessionSupport());
  server.use(passwordless.acceptToken({ successRedirect: URL_APP }));

  server.use((req, __, next) => {
    if (req.user && typeof req.user === 'string') {
      User.findById(req.user, User.publicFields(), (err, user) => {
        req.user = user;
        next(err);
      });
    } else {
      next();
    }
  });

  server.post(
    '/auth/send-token',
    passwordless.requestToken(
      async (email, __, callback) => {
        try {
          const user = await User.findOne({ email })
            .select('_id')
            .setOptions({ lean: true });

          if (user) {
            callback(null, user._id);
          } else {
            const id = await mongoStore.storeOrUpdateByEmail(email);
            callback(null, id);
          }
        } catch (error) {
          callback(error);
        }
      },
      { userField: 'email' },
    ),
    (__, res) => {
      res.json({ done: 1 });
    },
  );

  server.get('/logout', passwordless.logout(), (req, res) => {
    req.logout();
    res.redirect(`${URL_APP}/login`);
  });
}

let passportInit = true;
function setupPassport(type, server, options) {

  if (passportInit) {
    passport.serializeUser((user: IUserDocument, done) => {
      done(null, user._id);
    });

    passport.deserializeUser((id, done) => {
      // push the supported oauth's to the projection
      // they are not in publicFields because the virtuals
      // are used instead.
      User.findById(id, User.publicFields().concat(['googleId', 'microsoftId']), (err, user) => {
        done(err, user);
      });
    });

    server.use(passport.initialize());
    server.use(passport.session());
    passportInit = false;
  }

  server.get('/auth/' + type, (req, res, next) => {
    if (req.query && req.query.next && req.query.next.startsWith('/')) {
      req.session.next_url = req.query.next;
    } else {
      req.session.next_url = null;
    }

    if (req.query && req.query.invitationToken) {
      req.session.invitationToken = req.query.invitationToken;
    } else {
      req.session.invitationToken = null;
    }

    passport.authenticate(type, options)(req, res, next);
  });

  server.get(
    '/oauth2' + type,
    passport.authenticate(type, {
      failureRedirect: '/login',
    }),
    (req, res) => {
      if (req.user && req.session.invitationToken) {
        Invitation.addUserToTeam({ token: req.session.invitationToken, user: req.user }).catch(
          err => logger.error(err),
        );
      }

      let redirectUrlAfterLogin;

      if (req.user && req.session.next_url) {
        redirectUrlAfterLogin = req.session.next_url;
      } else {
        if (!req.user.defaultTeamSlug) {
          redirectUrlAfterLogin = '/create-team';
        } else {
          redirectUrlAfterLogin = `/team/${req.user.defaultTeamSlug}/discussions`;
        }
      }

      res.redirect(`${URL_APP}${redirectUrlAfterLogin}`);
    },
  );
}

function setupGoogle({ ROOT_URL, server }) {
  if (!GOOGLE_CLIENTID || !GOOGLE_CLIENTSECRET) { return; }

  const type = 'google';

  const verify = async (accessToken, refreshToken, profile, verified) => {
    let email;
    let avatarUrl;

    if (profile.emails) {
      email = profile.emails[0].value;
    }

    if (profile.photos && profile.photos.length > 0) {
      avatarUrl = profile.photos[0].value.replace('sz=50', 'sz=128');
    }

    try {
      const user = await User.signInOrSignUp(type, {
        oauthId: profile.id,
        email,
        oauthToken: { accessToken, refreshToken },
        displayName: profile.displayName,
        avatarUrl,
      });

      verified(null, user);
    } catch (err) {
      verified(err);
      logger.error(err);
    }
  };

  passport.use(type,
    new GoogleStrategy(
      {
        clientID: GOOGLE_CLIENTID,
        clientSecret: GOOGLE_CLIENTSECRET,
        callbackURL: `${ROOT_URL}/oauth2google`,
      },
      verify,
    ),
  );

  const options = {
    scope: ['profile', 'email'],
    prompt: 'select_account',
  };

  setupPassport(type, server, options);
}

function setupMicrosoft({ ROOT_URL, server }) {
  if (!MICROSOFT_CLIENTID || !MICROSOFT_CLIENTSECRET) { return; }
  const type = 'microsoft';

  const verify = async (accessToken, refreshToken, profile, verified) => {
    let email;

    if (profile.emails) {
      email = profile.emails[0].value;
    }

    // fix https://github.com/seanfisher/passport-microsoft/issues/4
    if (!email && profile._json && profile._json.userPrincipalName) {
      email = profile._json.userPrincipalName;
    }

    try {
      const user = await User.signInOrSignUp(type, {
        oauthId: profile.id,
        email,
        oauthToken: { accessToken, refreshToken },
        displayName: profile.displayName,
        avatarUrl: undefined,
      });

      verified(null, user);
    } catch (err) {
      verified(err);
      logger.error(err);
    }
  };

  passport.use(type,
    new MicrosoftStrategy(
      {
        clientID: MICROSOFT_CLIENTID,
        clientSecret: MICROSOFT_CLIENTSECRET,
        callbackURL: `${ROOT_URL}/oauth2microsoft`,
      },
      verify,
    ),
  );

  const options = {
    scope: ['user.read'],
  };
  setupPassport(type, server, options);
}
export { setupPasswordless, setupGoogle, setupMicrosoft };
