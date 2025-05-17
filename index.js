require('dotenv').config()
const express = require('express')
const mongoose = require('mongoose')
const path = require('path')
const cors = require('cors')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const multer = require('multer')
const cloudinary = require('cloudinary').v2
const { CloudinaryStorage } = require('multer-storage-cloudinary')

// Models
const User = require('./models/User')
const Paper = require('./models/Paper')

const app = express()

// Middleware
app.use(cors())
app.use(express.json())
app.use('/uploads', express.static(path.join(__dirname, 'uploads')))

// Cloudinary config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
})

// Cloudinary storage for Multer
const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'event-papers',
    allowed_formats: ['jpg', 'jpeg', 'png', 'pdf'],
  },
})

const upload = multer({ storage })

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})

// JWT Middleware
const authenticate = (req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '')
  if (!token) return res.status(401).send('Access denied. No token provided.')
  try {
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || 'your-secret-key'
    )
    req.user = decoded
    next()
  } catch (err) {
    res.status(400).send('Invalid token.')
  }
}

// Admin Login
app.post('/api/admin/login', async (req, res) => {
  if (
    req.body.username !== 'admin' ||
    req.body.password !== process.env.ADMIN_PASSWORD
  ) {
    return res.status(400).send('Invalid credentials')
  }

  const token = jwt.sign(
    { _id: 'admin', isAdmin: true },
    process.env.JWT_SECRET || 'your-secret-key'
  )
  res.send({ token })
})

// Moderator Login
app.post('/api/moderators/login', async (req, res) => {
  const moderator = await User.findOne({ username: req.body.username })
  if (!moderator) return res.status(400).send('Invalid username or password.')

  const validPassword = await bcrypt.compare(
    req.body.password,
    moderator.password
  )
  if (!validPassword)
    return res.status(400).send('Invalid username or password.')

  const token = jwt.sign(
    { _id: moderator._id, username: moderator.username },
    process.env.JWT_SECRET || 'your-secret-key'
  )
  res.send({ token, username: moderator.username })
})

// Create moderator (admin only)
app.post('/api/moderators', authenticate, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).send('Access denied.')

  let user = await User.findOne({ username: req.body.username })
  if (user) return res.status(400).send('Moderator already registered.')

  const salt = await bcrypt.genSalt(10)
  const hashedPassword = await bcrypt.hash(req.body.password, salt)

  user = new User({ username: req.body.username, password: hashedPassword })
  await user.save()
  res.send({ username: user.username })
})

// List all moderators (admin only)
app.get('/api/moderators', authenticate, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).send('Access denied.')

  const moderators = await User.find({}, '-password')
  res.send(moderators)
})

// Delete moderator and their papers (admin only)
app.delete('/api/moderators/:id', authenticate, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).send('Access denied.')

  const moderator = await User.findByIdAndDelete(req.params.id)
  if (!moderator) return res.status(404).send('Moderator not found.')

  await Paper.deleteMany({ moderatorId: req.params.id })

  res.send({ message: 'Moderator deleted successfully' })
})

// Upload new paper (admin only)
app.post(
  '/api/papers',
  authenticate,
  upload.array('files'),
  async (req, res) => {
    if (!req.user.isAdmin) return res.status(403).send('Access denied.')

    const files = req.files.map((file) => ({
      url: file.path,
      public_id: file.filename,
      originalName: file.originalname,
    }))

    const paper = new Paper({
      moderatorId: req.body.moderatorId,
      title: req.body.title,
      note: req.body.note,
      files,
    })

    await paper.save()
    res.send(paper)
  }
)

// Update paper (note + optional file uploads)
app.put(
  '/api/papers/:id',
  authenticate,
  upload.array('files'),
  async (req, res) => {
    if (!req.user.isAdmin) return res.status(403).send('Access denied.')

    const paper = await Paper.findById(req.params.id)
    if (!paper) return res.status(404).send('Paper not found.')

    if (req.body.note) paper.note = req.body.note

    if (req.files.length > 0) {
      const newFiles = req.files.map((file) => ({
        url: file.path,
        public_id: file.filename,
        originalName: file.originalname,
      }))
      paper.files.push(...newFiles)
    }

    paper.updatedAt = Date.now()
    await paper.save()

    res.send(paper)
  }
)

// Delete specific file from a paper
app.delete(
  '/api/papers/:paperId/files/:fileId',
  authenticate,
  async (req, res) => {
    try {
      const paper = await Paper.findById(req.params.paperId)
      if (!paper) return res.status(404).send('Paper not found.')

      const file = paper.files.id(req.params.fileId)
      if (!file) return res.status(404).send('File not found.')

      // Delete from Cloudinary
      await cloudinary.uploader.destroy(file.public_id)

      // Remove from MongoDB
      file.remove()
      await paper.save()

      res.send({ message: 'File deleted successfully' })
    } catch (error) {
      res.status(500).send('Error deleting file')
    }
  }
)

// Get papers for a specific moderator (admin or self)
app.get(
  '/api/papers/moderator/:moderatorId',
  authenticate,
  async (req, res) => {
    if (!req.user.isAdmin && req.user._id !== req.params.moderatorId) {
      return res.status(403).send('Access denied.')
    }

    const papers = await Paper.find({ moderatorId: req.params.moderatorId })
    res.send(papers)
  }
)

// Delete a full paper
app.delete('/api/papers/:id', authenticate, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).send('Access denied.')

  const paper = await Paper.findByIdAndDelete(req.params.id)
  if (!paper) return res.status(404).send('Paper not found.')

  // Optionally delete files from Cloudinary
  for (const file of paper.files) {
    await cloudinary.uploader.destroy(file.public_id)
  }

  res.send({ message: 'Paper deleted successfully' })
})

// Start server
const PORT = process.env.PORT || 5000
app.listen(PORT, () => console.log(`Server running on port ${PORT}`))
