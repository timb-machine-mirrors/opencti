/* eslint-disable camelcase */
import express from 'express';
import * as R from 'ramda';
// noinspection NodeCoreCodingAssistance
import { readFileSync } from 'fs';
// noinspection NodeCoreCodingAssistance
import path from 'path';
import bodyParser from 'body-parser';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import compression from 'compression';
import helmet from 'helmet';
import { isEmpty } from 'ramda';
import nconf from 'nconf';
import RateLimit from 'express-rate-limit';
import sanitize from 'sanitize-filename';
import contentDisposition from 'content-disposition';
import { DEV_MODE, logger, OPENCTI_TOKEN } from './config/conf';
import passport from './config/providers';
import { authentication, setAuthenticationCookie } from './domain/user';
import { downloadFile, loadFile } from './database/minio';
import { checkSystemDependencies } from './initialization';
import { getSettings } from './domain/settings';
import createSeeMiddleware from './graphql/sseMiddleware';
import initTaxiiApi from './taxiiApi';

const createApp = async (apolloServer, broadcaster) => {
  // Init the http server
  const app = express();
  app.set('json spaces', 2);
  const limiter = new RateLimit({
    windowMs: nconf.get('app:rate_protection:time_window') * 1000, // seconds
    max: nconf.get('app:rate_protection:max_requests'),
    handler: (req, res /* , next */) => {
      res.status(429).send({ message: 'Too many requests, please try again later.' });
    },
  });
  const sessionSecret = nconf.get('app:session_secret') || nconf.get('app:admin:password');
  const scriptSrc = ["'self'", "'unsafe-inline'", 'http://cdn.jsdelivr.net/npm/@apollographql/'];
  if (DEV_MODE) scriptSrc.push("'unsafe-eval'");
  app.use(session({ secret: sessionSecret, saveUninitialized: true, resave: true }));
  app.use(cookieParser());
  app.use(compression());
  app.use(helmet());
  app.use(helmet.frameguard());
  app.use(helmet.expectCt({ enforce: true, maxAge: 30 }));
  app.use(helmet.referrerPolicy({ policy: 'unsafe-url' }));
  app.use(
    helmet.contentSecurityPolicy({
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc,
        styleSrc: [
          "'self'",
          "'unsafe-inline'",
          'http://cdn.jsdelivr.net/npm/@apollographql/',
          'https://fonts.googleapis.com/',
        ],
        fontSrc: ["'self'", 'https://fonts.gstatic.com/'],
        imgSrc: ["'self'", 'data:', 'https://*', 'http://*'],
        connectSrc: ["'self'", 'wss://*', 'ws://*'],
        objectSrc: ["'none'"],
      },
    })
  );
  app.use(bodyParser.json({ limit: '100mb' }));
  app.use(limiter);

  let seeMiddleware;
  if (broadcaster) {
    seeMiddleware = createSeeMiddleware(broadcaster);
    seeMiddleware.applyMiddleware({ app });
  }

  const extractTokenFromBearer = (bearer) => (bearer && bearer.length > 10 ? bearer.substring('Bearer '.length) : null);
  const AppBasePath = nconf.get('app:base_path').trim();
  const contextPath = isEmpty(AppBasePath) || AppBasePath === '/' ? '' : AppBasePath;
  const basePath = isEmpty(AppBasePath) || contextPath.startsWith('/') ? contextPath : `/${contextPath}`;
  const urlencodedParser = bodyParser.urlencoded({ extended: true });

  // -- Init Taxii rest api
  initTaxiiApi(basePath, app);

  // -- Generated CSS with correct base path
  app.get(`${basePath}/static/css/*`, (req, res) => {
    const cssFileName = R.last(req.url.split('/'));
    const data = readFileSync(path.join(__dirname, `../public/static/css/${sanitize(cssFileName)}`), 'utf8');
    const withBasePath = data.replace(/%BASE_PATH%/g, basePath);
    res.header('Content-Type', 'text/css');
    res.send(withBasePath);
  });
  app.use(`${basePath}/static`, express.static(path.join(__dirname, '../public/static')));

  // -- File download
  app.get(`${basePath}/storage/get/:file(*)`, async (req, res) => {
    let token = req.cookies ? req.cookies[OPENCTI_TOKEN] : null;
    token = token || extractTokenFromBearer(req.headers.authorization);
    const auth = await authentication(token);
    if (!auth) res.sendStatus(403);
    const { file } = req.params;
    const stream = await downloadFile(file);
    res.attachment(file);
    stream.pipe(res);
  });

  // -- File view
  app.get(`${basePath}/storage/view/:file(*)`, async (req, res) => {
    let token = req.cookies ? req.cookies[OPENCTI_TOKEN] : null;
    token = token || extractTokenFromBearer(req.headers.authorization);
    const auth = await authentication(token);
    if (!auth) res.sendStatus(403);
    const { file } = req.params;
    const data = await loadFile(file);
    res.setHeader('Content-disposition', contentDisposition(data.name, { type: 'inline' }));
    res.setHeader('Content-type', data.metaData.mimetype);
    const stream = await downloadFile(file);
    stream.pipe(res);
  });

  // -- Passport login
  app.get(`${basePath}/auth/:provider`, (req, res, next) => {
    const { provider } = req.params;
    passport.authenticate(provider)(req, res, next);
  });

  // -- Passport callback
  app.get(`${basePath}/auth/:provider/callback`, urlencodedParser, passport.initialize(), (req, res, next) => {
    const { provider } = req.params;
    passport.authenticate(provider, (err, token) => {
      if (err || !token) {
        return res.redirect(`/dashboard?message=${err.message}`);
      }
      setAuthenticationCookie(token, res);
      return res.redirect('/dashboard');
    })(req, res, next);
  });

  // -- HealthCheck
  const serverHealthCheck = () => checkSystemDependencies().then(() => getSettings());

  // Apply middleware to answer to graphql call
  apolloServer.applyMiddleware({ app, onHealthCheck: serverHealthCheck, path: `${basePath}/graphql` });

  // Other routes - Render index.html
  app.get('*', (req, res) => {
    const data = readFileSync(`${__dirname}/../public/index.html`, 'utf8');
    const withOptionValued = data.replace(/%BASE_PATH%/g, basePath);
    res.header('Cache-Control', 'private, no-cache, no-store, must-revalidate');
    res.header('Expires', '-1');
    res.header('Pragma', 'no-cache');
    return res.send(withOptionValued);
  });

  // Error handling
  app.use((err, req, res, next) => {
    logger.error(`[EXPRESS] Error http call`, { error: err });
    res.redirect('/');
    next();
  });

  return { app, seeMiddleware };
};

export default createApp;
