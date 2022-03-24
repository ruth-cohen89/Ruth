const crypto = require('crypto');
const { promisify } = require('util');
const jwt = require('jsonwebtoken');
const client = require('twilio')(
  process.env.TWILLO_ACCOUNT_SID,
  process.env.TWILLO_AUTH_TOKEN
);

const User = require('../models/userModel');
const RefreshToken = require('../models/refreshTokenModel');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const Email = require('../utils/email');

// Protect - for authentication
// RestrictTo - for authorization

// Create token and return
const signAccessToken = (id) =>
  // (payload, key, header options)
  jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN,
  });

// Create token & access token for login only
const createSendToken = async (user, statusCode, res) => {
  const accessToken = signAccessToken(user._id);

  // we create the refresh token with random and not jwt
  // so it will not be the same as access token with jwt
  // (also to have multiple ref tok per a user)
  // and a model to save it there
  // create refresh token as an object

  const refreshToken = await RefreshToken.createToken(user);

  const cookieOptions = {
    //converting days to ms
    expires: new Date(
      Date.now() + process.env.JWT_COOKIE_EXPIRES_IN * 24 * 60 * 60 * 1000
    ),

    //Don't let the browser modify/access the cookie
    // we cant manipulate/delete the cookie in the front end js code on the browser
    //Preventing cross-site-scripting attacks - the attacker may reach LS of the browser
    httpOnly: true,
  };

  // In production the cookie will be sent only on https (for hiding the token inside)
  if (process.env.NODE_ENV === 'production') cookieOptions.secure = true;

  // SEND COOKIE
  //Create cookie named jwt and data (token) we want to send in the cookie
  res.cookie('jwt', accessToken, refreshToken, cookieOptions);
  res.cookie('refreshToken', refreshToken, cookieOptions);

  //All properties of a document that are selected as false
  //won't be displayed when the user asks to see the user document
  //but when creating a new doc (user) all assined fields are returned and seen
  // in the res, so in order to hide the password in the response, we do this:

  //Remove the password from the output
  user.password = undefined;

  //SEND RESOPNSE(body) in a promise which will be resolved by await
  res.status(statusCode).json({
    status: 'success',
    accessToken,
    refreshToken,
    data: {
      user,
    },
  });
};

exports.signup = catchAsync(async (req, res, next) => {
  // 1) Create user data
  const newUser = await User.create({
    name: req.body.name,
    email: req.body.email,
    password: req.body.password,
    passwordConfirm: req.body.passwordConfirm,
    role: req.body.role,
    // false until user confirms his email address
    emailConfirmed: false,
  });

  // 2) Generate confirm email random token
  // createEmailConfirmToken modifies the data in user
  //and returns the unencryped version of the token
  const confirmToken = newUser.createEmailConfirmToken();

  // Here we save the changes witout validating because we didnt modify all fields
  // Save user modification in createEmailConfirmToken
  await newUser.save({ validateBeforeSave: false });

  const confirmURL = `${req.protocol}://${req.get(
    'host'
  )}/emailConfirm/${confirmToken}`;
  await new Email(newUser, confirmURL).sendWelcome();
  // console.log(confirmURL);

  // Delete last cookie
  // res.cookie('jwt', 'loggedout', {
  //   expires: new Date(Date.now() + 10 * 1000),
  //   httpOnly: true,
  // });
  res.status(200).json({
    status: 'success',
    message: 'Confimiration email successfuly sent to your address',
    data: {
      newUser,
    },
  });
});

exports.emailConfirm = catchAsync(async (req, res, next) => {
  //console.log('confirming...', req.originalUrl);
  // console.log('confirming...', req.params.token)
  // 1) Get user based on the token
  const hashedToken = crypto
    .createHash('sha256')
    .update(req.params.token)
    .digest('hex');
  const user = await User.findOne({
    confirmEmailToken: hashedToken,
    confirmEmailExpires: { $gt: Date.now() },
  });
  //console.log('po', user)
  if (!user) {
    return next(new AppError('Token is invalid or has expired', 400));
  }
  // 2) If token has not expired, and there is user, confirm the email
  user.emailConfirmed = true;
  console.log('po', user.emailConfirmed)
  // Reset the confirm tk
  user.passwordResetToken = undefined;
  user.passwordResetExpires = undefined;
  // 3) Update
  await user.save({ validateBeforeSave: false });

  // 4) Log the user in, send JWT, now the reset password token will be forgotten - not valid
  createSendToken(user, 200, res);
});

exports.sendSms = catchAsync(async (req, res, next) => {
  const result = await client.verify
    .services(process.env.TWILLO_SERVICE_SID)
    .verifications.create({
      to: `+${req.query.phoneNumber}`,
      channel: req.query.channel,
    });
  if (!result) {
    return next(new AppError('Problem sending sms', 400));
  }
  res.status(200).json({
    status: 'success',
    data: {
      result,
    },
  });
});

exports.verifyCode = catchAsync(async (req, res, next) => {
  console.log('shalom');
  const result = await client.verify
    .services(process.env.TWILLO_SERVICE_SID)
    .verificationChecks.create({
      to: `+${req.query.phoneNumber}`,
      code: req.query.code,
    });
  if (!result) {
    return next(new AppError('Problem veryfing user', 400));
  }
  res.status(200).json({
    status: 'success',
    data: {
      result,
    },
  });
});

//login - verify name and password and create a token
exports.login = catchAsync(async (req, res, next) => {
  const { email, password } = req.body;
  // console.log(req.header)

  // 1) Check if the email and passowrd are valid
  if (!email || !password) {
    //create an error & send it to the global error mw handler
    //return makes sure that the login function finishes here
    return next(new AppError('Please provide email and password', 400));
  }

  // 2) Check if the user exists && password is correct
  //find by email, select - return fields that by default are false(not displayed)
  const user = await User.findOne({ email }).select('+password emailConfirmed'); ///working?
  //console.log(user);
  if (!user || !(await user.correctPassword(password, user.password))) {
    return next(new AppError('Inncorrect email or password', 401));
  }
  //console.log('here',user.emailConfirmed)
  if (!user.emailConfirmed) {
    return next(
      new AppError('You have not confirmed your email address!', 401)
    );
  }

  // 3) If everything is ok, send token to client
  createSendToken(user, 200, res);
});

exports.logout = (req, res) => {
  res.cookie('jwt', 'loggedout', {
    expires: new Date(Date.now() + 10 * 1000),
    httpOnly: true,
  });
  res.status(200).json({ status: 'success' });
};

// Create new access token when the current has expired
exports.refreshToken = catchAsync(async (req, res, next) => {
  const { refreshToken: requestToken } = req.body;
  if (requestToken == null) {
    return next(new AppError('Refresh Token is required!', 403));
  }
  const refreshToken = await RefreshToken.findOne({ token: requestToken });
  if (!refreshToken) {
    return next(new AppError('Refresh token is not in database!', 403));
  }

  // If refresh token has expired
  if (RefreshToken.verifyExpiration(refreshToken)) {

    // Remove from db
    RefreshToken.findByIdAndRemove(refreshToken._id, {
      useFindAndModify: false,
    }).exec();
    return next(
      new AppError(
        'Refresh token was expired. Please make a new signin request',
        403
      )
    );
  }

  // Remove from db
  RefreshToken.findByIdAndRemove(refreshToken._id, {
    useFindAndModify: false,
  }).exec();

  // New tokens
  const newAccessToken = signAccessToken(refreshToken.user._id);
  const newRefreshToken = await RefreshToken.createToken(refreshToken.user._id);
  res.cookie('jwt', newAccessToken, {
    expires: new Date(Date.now() + 10 * 1000),
    httpOnly: true,
  });
  res.cookie('refreshToken', {
    expires: new Date(Date.now() + 10 * 1000),
    httpOnly: true,
  });

  res.status(200).json({
    status: 'success',
    message: 'New access and refresh tokens.',
    accessToken: newAccessToken,
    refreshToken: newRefreshToken,
  });
});

//Authenticate the user by his access token
exports.protect = catchAsync(async (req, res, next) => {
  // 1) Getting token and check of it's there
  let token;
  // If the client is postman, the API tester
  // then it will send the token in a header "Bearer"
  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer')
  ) {
    //console.log('bearer')
    token = req.headers.authorization.split(' ')[1];
    //If the client is the browser
    // then the token will be sent in a cookie
  } else if (req.cookies.jwt) {
    // console.log('cookie')
    token = req.cookies.jwt;
  }
  if (!token || token === 'null') {
    return next(
      new AppError('You are not logged in! Please log in to get access.', 401)
    );
  }

  // 2) Verification token
  //this functions 3rd arg should be a callback that will return the token, but we want to work with promises!
  //so we make it return a promise instead, by using promisify,
  // returning the token if successful
  const decoded = await promisify(jwt.verify)(token, process.env.JWT_SECRET);

  // 3) Check if user still exists
  //maybe the user has been deleted after the token has been issued
  //Maybe his token was stolen and the he deleted his account(to protect maybe)...
  const currentUser = await User.findById(decoded.id);
  if (!currentUser) {
    return next(
      new AppError(
        'The user belonging to this token does no longer exist.',
        401
      )
    );
  }

  // 4) Check if user changed password after the token was issued
  ///his password has changed after the token has been issued
  //If his token was stolen, the user changes password to protect his information
  // iat - issued at
  if (currentUser.changedPasswordAfter(decoded.iat)) {
    return next(
      new AppError('User recently changed password! Please log in again.', 401)
    );
  }

  // GRANT ACCESS TO PROTECTED ROUTE
  //Identify the user in request (we would use this data in next middlewares)
  req.user = currentUser;
  res.locals.user = currentUser;
  next();
});

// Only for rendered pages, no errors!
// Deciding how the header will look like
exports.isLoggedIn = async (req, res, next) => {
  if (req.cookies.jwt) {
    try {
      // 1) verify token
      const decoded = await promisify(jwt.verify)(
        req.cookies.jwt,
        process.env.JWT_SECRET
      );

      // 2) Check if user still exists
      const currentUser = await User.findById(decoded.id);
      if (!currentUser) {
        return next();
      }

      // 3) Check if user changed password after the token was issued
      if (currentUser.changedPasswordAfter(decoded.iat)) {
        return next();
      }

      // THERE IS A LOGGED IN USER
      res.locals.user = currentUser;
      return next();
    } catch (err) {
      return next();
    }
  }
  next();
};

// Authorization
exports.restrictTo =
  (...roles) =>
  (req, res, next) => {
    // roles ['admin', 'lead-guide'], role='user'
    if (!roles.includes(req.user.role)) {
      return next(
        new AppError('You do not have permission to perform this action', 403)
      );
    }

    next();
  };

exports.forgotPassword = catchAsync(async (req, res, next) => {
  // 1) Get user based on POSTed email
  const user = await User.findOne({ email: req.body.email });
  if (!user) {
    return next(new AppError('There is no user with this email address.', 404));
  }

  // 2) Generate the random reset token
  const resetToken = user.createPasswordResetToken();

  // Save changes witout validating - not all fields were modified
  await user.save({ validateBeforeSave: false });
  // 3) Send it to user's email
  try {
    const resetURL = `${req.protocol}://${req.get(
      'host'
    )}/resetPassword/${resetToken}`;
    await new Email(user, resetURL).sendPasswordReset();

    res.status(200).json({
      status: 'success',
      message: 'Token sent to email!',
    });
  } catch (err) {
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    await user.save({ validateBeforeSave: false });

    return next(
      new AppError('There was an error sending the email. Try again later!'),
      500
    );
  }
});

exports.resetPassword = catchAsync(async (req, res, next) => {
  // 1) Get user based on the token
  console.log(req.originalUrl);
  const hashedToken = crypto
    .createHash('sha256')
    .update(req.params.token)
    .digest('hex');
  const user = await User.findOne({
    passwordResetToken: hashedToken,
    passwordResetExpires: { $gt: Date.now() },
  });

  // 2) If token has not expired, and there is user, set the new password
  if (!user) {
    return next(new AppError('Token is invalid or has expired', 400));
  }
  user.password = req.body.password;
  user.passwordConfirm = req.body.passwordConfirm;
  user.passwordResetToken = undefined;
  user.passwordResetExpires = undefined;
  // 3) Update changedPasswordAt property for the user is by pre mw
  await user.save();

  // 4) Log the user in, send JWT, now the reset password token will be forgotten - not valid
  createSendToken(user, 200, res);
});

//Logged-in user changes his password (protect mw set the user in the req before)
exports.updatePassword = catchAsync(async (req, res, next) => {
  //If someone access your open computer when you are logged he can your password
  //so as a security measure, we ask him for the current password

  // 1)  Get user from the collection,
  // req.user doesnt conatain the password field, that's why we fetch it now
  //password is hidden by default, so we specify that we want to get it
  const user = await User.findById(req.user.id).select('+password');

  // 2) Check if POSTed password is correct and user is found
  if (!(await user.correctPassword(req.body.passwordCurrent, user.password))) {
    return next(new AppError('Your current password is wrong!', 401)); //401, unauthorized
  }

  // 3a) If so, update password
  user.password = req.body.password;
  user.passwordConfirm = req.body.passwordConfirm;

  // 3b) Update changedPasswordAt property for the user,
  // validate passwordConfirm, and encrypt by pre doc mw
  await user.save();
  // User.findByIdUpdate will NOT work as intended!

  // 4) Log user in, send JWT
  createSendToken(user, 200, res);
});
