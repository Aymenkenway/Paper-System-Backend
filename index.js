require('dotenv').config()
const express = require('express')
const mongoose = require('mongoose')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const multer = require('multer')
const path = require('path')
const cors = require('cors')

const app = express()
app.use(cors())
app.use(express.json())
app.use('/uploads', express.static(path.join(__dirname, 'uploads')))

// MongoDB Connection
mongoose.connect(
  process.env.MONGODB_URI || 'mongodb://localhost:27017/paperReviewSystem',
  {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  }
)

// Models
const User = require('./models/User')
const Paper = require('./models/Paper')

// Middleware to verify JWT
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
  } catch (ex) {
    res.status(400).send('Invalid token.')
  }
}

// File upload setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/')
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`)
  },
})

const upload = multer({ storage })

// Routes

// Admin login
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

// Moderator login
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

// Admin routes
app.post('/api/moderators', authenticate, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).send('Access denied.')

  let user = await User.findOne({ username: req.body.username })
  if (user) return res.status(400).send('Moderator already registered.')

  const salt = await bcrypt.genSalt(10)
  const hashedPassword = await bcrypt.hash(req.body.password, salt)

  user = new User({
    username: req.body.username,
    password: hashedPassword,
  })

  await user.save()
  res.send({ username: user.username })
})

app.get('/api/moderators', authenticate, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).send('Access denied.')

  const moderators = await User.find({}, '-password')
  res.send(moderators)
})

app.delete('/api/moderators/:id', authenticate, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).send('Access denied.')

  const moderator = await User.findByIdAndDelete(req.params.id)
  if (!moderator) return res.status(404).send('Moderator not found.')

  // Delete all papers associated with this moderator
  await Paper.deleteMany({ moderatorId: req.params.id })

  res.send({ message: 'Moderator deleted successfully' })
})

// Paper routes
app.post(
  '/api/papers',
  authenticate,
  upload.array('files'),
  async (req, res) => {
    if (!req.user.isAdmin) return res.status(403).send('Access denied.')

    const files = req.files.map((file) => ({
      path: file.path,
      originalName: file.originalname,
    }))

    const paper = new Paper({
      moderatorId: req.body.moderatorId,
      title: req.body.title,
      note: req.body.note,
      files: files,
    })

    await paper.save()
    res.send(paper)
  }
)
// app.post(
//   '/api/papers',
//   authenticate,
//   upload.single('paper'),
//   async (req, res) => {
//     if (!req.user.isAdmin) return res.status(403).send('Access denied.')

//     const paper = new Paper({
//       moderatorId: req.body.moderatorId,
//       title: req.body.title,
//       note: req.body.note,
//       filePath: req.file.path,
//       originalName: req.file.originalname,
//     })

//     await paper.save()
//     res.send(paper)
//   }
// )
// Update paper (note and files)
app.put(
  '/api/papers/:id',
  authenticate,
  upload.array('files'),
  async (req, res) => {
    if (!req.user.isAdmin) return res.status(403).send('Access denied.')

    try {
      const paper = await Paper.findById(req.params.id)
      if (!paper) return res.status(404).send('Paper not found.')

      // Update note if provided
      if (req.body.note) {
        paper.note = req.body.note
      }

      // Add new files if uploaded
      if (req.files && req.files.length > 0) {
        const newFiles = req.files.map((file) => ({
          path: file.path,
          originalName: file.originalname,
        }))
        paper.files.push(...newFiles)
      }

      paper.updatedAt = Date.now()
      await paper.save()

      res.send(paper)
    } catch (error) {
      res.status(500).send('Error updating paper')
    }
  }
)

// Delete a specific file from a paper
app.delete(
  '/api/papers/:paperId/files/:fileId',
  authenticate,
  async (req, res) => {
    if (!req.user.isAdmin) return res.status(403).send('Access denied.')

    try {
      const paper = await Paper.findById(req.params.paperId)
      if (!paper) return res.status(404).send('Paper not found.')

      const fileIndex = paper.files.findIndex(
        (f) => f._id.toString() === req.params.fileId
      )
      if (fileIndex === -1) return res.status(404).send('File not found.')

      // Remove file from array
      const [deletedFile] = paper.files.splice(fileIndex, 1)

      // Optionally delete the file from filesystem here
      // fs.unlinkSync(deletedFile.path);

      await paper.save()
      res.send({ message: 'File deleted successfully' })
    } catch (error) {
      res.status(500).send('Error deleting file')
    }
  }
)

app.get(
  '/api/papers/moderator/:moderatorId',
  authenticate,
  async (req, res) => {
    // Allow access for admin or the specific moderator
    if (!req.user.isAdmin && req.user._id !== req.params.moderatorId) {
      return res.status(403).send('Access denied.')
    }

    const papers = await Paper.find({ moderatorId: req.params.moderatorId })
    res.send(papers)
  }
)

app.delete('/api/papers/:id', authenticate, async (req, res) => {
  if (!req.user.isAdmin) return res.status(403).send('Access denied.')

  const paper = await Paper.findByIdAndDelete(req.params.id)
  if (!paper) return res.status(404).send('Paper not found.')

  // Optionally delete the file from the filesystem
  // fs.unlinkSync(paper.filePath);

  res.send({ message: 'Paper deleted successfully' })
})

// Start server
const PORT = process.env.PORT || 5000
app.listen(PORT, () => console.log(`Server running on port ${PORT}`))
