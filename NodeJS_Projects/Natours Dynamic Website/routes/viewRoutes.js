const express = require('express');

const viewsController = require('../controllers/viewsController');
const authController = require('../controllers/authController');
const bookingController = require('../controllers/bookingController');

const router = express.Router();

// ROUTES which return a dynamic rendered file

// Rendering 'base' file (the root page) in the browser
// We can pass data in {} to the rendered file
//finding that file in the views folder we specidied ('base')
// when sending JSON data we specified .route() first, but here we only want get reqs
// The overview is the root, default

// Decide if user is logged in
//router.use(authController.isLoggedIn);

router.get(
  '/',
  bookingController.createBookingCheckout,
  authController.isLoggedIn,
  viewsController.getOverview
);
router.get('/tour/:slug', authController.isLoggedIn, viewsController.getTour);
router.get('/login', authController.isLoggedIn, viewsController.getLoginForm);
router.get('/forgotPassword', viewsController.forgotPassword);
router.get('/resetPassword/:token', viewsController.resetPassword);

// protect mw also check if user is logged in
router.get('/me', authController.protect, viewsController.getAccount);
router.get('/my-tours', authController.protect, viewsController.getMyTours);

//no need for protect,
//the update route in the API passes throught this already in userRoutes
//router.post('/submit-user-data', viewsController.updateUserData);

module.exports = router;