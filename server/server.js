require('dotenv').config()
const express = require('express')
const bodyParser = require('body-parser')
const { verifyCaptcha } = require('./middleware')
const {
  transporter,
  emailTemplate,
  purchaseEmailTemplate,
} = require('./mailer')
const path = require('path')
const cors = require('cors')
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)
const MyRedis = require('./redis')
const whitelist = require('./whitelist')

const app = express()
const port = process.env.PORT || 4000

// setup cors
const isProduction = process.env.NODE_ENV === 'production'
const corsOptions = {
  origin: true,
  optionsSuccessStatus: 200, // some legacy browsers (IE11, various SmartTVs) choke on 204
}

if (isProduction) {
  corsOptions.origin = function (origin, callback) {
    if (whitelist.indexOf(origin) !== -1 || !origin) {
      callback(null, true)
    } else {
      callback(new Error('Not allowed by CORS'))
    }
  }
}

/**
 * MIDDLEWARES
 */
app.use(cors(corsOptions))
app.use(bodyParser.json())

/**
 * ENABLE ROUTES
 */
const buildPath = path.resolve('./build')
const frontEndRoutes = [
  '/',
  '/about',
  '/faq',
  '/contact',
  '/work',
  '/work/*',
  '/shop/*',
  '/east'
]
frontEndRoutes.forEach((r) => {
  app.use(r, express.static(buildPath))
})

/**
 * API
 */

app.post('/api/email', verifyCaptcha, async (req, res) => {
  const { message, email, name, subject } = req.body
  try {
    let result = await transporter.sendMail({
      from: process.env.EMAIL_USERNAME,
      to: process.env.EMAIL_USERNAME,
      subject: `NEW MESSAGE: ${name}`,
      html: emailTemplate(name, subject, email, message),
    })

    res.status(200).send({ message: 'Message Sent', data: result })
  } catch (err) {
    console.log('ERROR', err)
    res.status(500).send({ message: 'Error sending message', err })
  }
})

app.post('/api/payment', verifyCaptcha, async (req, res) => {
  try {
    const { cart, clientInfo } = req.body
    // set info in redis.

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: cart,
      customer_email: clientInfo.email,
      success_url: `${process.env.HOME_URL}/shop/success`,
      cancel_url: `${process.env.HOME_URL}/shop/cancel`,
    })

    await MyRedis.setAsync(
      session.id,
      JSON.stringify({ ...clientInfo, processed: false })
    )

    res.status(200).send({ message: 'Session created', data: { session } })
  } catch (err) {
    console.log('ERROR CREATING SESSION', err)
    res.status(500).send({ message: 'Error creating session', err })
  }
})

app.post('/api/payment/webhook', async (req, res) => {
  let event = req.body

  // Handle the checkout.session.completed event
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object

    // Fulfill the purchase...
    const clientInfo = JSON.parse(await MyRedis.getAsync(session.id))
    console.log({ clientInfo, session })
    // send client reciept
    let result1 = await transporter.sendMail({
      from: process.env.EMAIL_USERNAME,
      to: clientInfo.email,
      subject: `Purchase Receipt from Chalupagrande.com`,
      html: purchaseEmailTemplate({ clientInfo, session }),
    })

    // send myself a reciept
    let result2 = await transporter.sendMail({
      from: process.env.EMAIL_USERNAME,
      to: process.env.EMAIL_USERNAME,
      subject: `Purchase Receipt from Chalupagrande.com`,
      html: purchaseEmailTemplate({ clientInfo, session }),
    })
    const isDeleted = await MyRedis.delAsync(session.id)
    console.log('DELETED?', isDeleted)
  }

  // Return a response to acknowledge receipt of the event
  res.json({ received: true })
})

/**
 * LISTEN
 */

app.listen(port)
console.log(`listening on ${port}`)
