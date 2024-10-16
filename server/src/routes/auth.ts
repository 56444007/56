import { Router, Request, Response } from 'express';
import User from '../models/User';
import jwt from 'jsonwebtoken';
import { hashPassword, comparePassword } from '../utils/auth';
import { requireSignIn } from '../middlewares/auth';
import { genAPIKey } from '../utils/api';
import { google } from 'googleapis';
export const router = Router();

interface AuthenticatedRequest extends Request {
    user?: { id: string };
}

router.post('/register', async (req, res) => {
    try {
        const { email, password } = req.body

        if (!email) return res.status(400).send('Email is required')
        if (!password || password.length < 6) return res.status(400).send('Password is required and must be at least 6 characters')

        let userExist = await User.findOne({ raw: true, where: { email } });
        if (userExist) return res.status(400).send('User already exists')

        const hashedPassword = await hashPassword(password)

        const user = await User.create({ email, password: hashedPassword });

        const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET as string, { expiresIn: '12h' });
        user.password = undefined as unknown as string
        res.cookie('token', token, {
            httpOnly: true
        })
        res.json(user)
    } catch (error: any) {
        res.status(500).send(`Could not register user - ${error.message}`)
    }
})

router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).send('Email and password are required')
        if (password.length < 6) return res.status(400).send('Password must be at least 6 characters')

        let user = await User.findOne({ raw: true, where: { email } });
        if (!user) return res.status(400).send('User does not exist');

        const match = await comparePassword(password, user.password)
        if (!match) return res.status(400).send('Invalid email or password')

        const token = jwt.sign({ id: user?.id }, process.env.JWT_SECRET as string, { expiresIn: '12h' });

        // return user and token to client, exclude hashed password
        if (user) {
            user.password = undefined as unknown as string;
        }
        res.cookie('token', token, {
            httpOnly: true
        })
        res.json(user)
    } catch (error: any) {
        res.status(400).send(`Could not login user - ${error.message}`)
        console.log(`Could not login user - ${error}`)
    }
})

router.get('/logout', async (req, res) => {
    try {
        res.clearCookie('token')
        return res.json({ message: 'Logout successful' })
    } catch (error: any) {
        res.status(500).send(`Could not logout user - ${error.message}`)
    }
})

router.get('/current-user', requireSignIn, async (req: AuthenticatedRequest, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ ok: false, error: 'Unauthorized' });
        }
        const user = await User.findByPk(req.user.id, {
            attributes: { exclude: ['password'] },
        });
        if (!user) {
            return res.status(404).json({ ok: false, error: 'User not found' });
        } else {
            return res.status(200).json({ ok: true, user: user });
        }
    } catch (error: any) {
        console.error('Error in current-user route:', error);
        return res.status(500).json({ ok: false, error: `Could not fetch current user: ${error.message}` });
    }
});

router.post('/generate-api-key', requireSignIn, async (req: AuthenticatedRequest, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ ok: false, error: 'Unauthorized' });
        }
        const user = await User.findByPk(req.user.id, {
            attributes: { exclude: ['password'] },
        });

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        if (user.api_key) {
            return res.status(400).json({ message: 'API key already exists' });
        }
        const apiKey = genAPIKey();

        await user.update({ api_key: apiKey });

        return res.status(200).json({
            message: 'API key generated successfully',
            api_key: apiKey,
        });
    } catch (error) {
        return res.status(500).json({ message: 'Error generating API key', error });
    }
});

router.get('/api-key', requireSignIn, async (req: AuthenticatedRequest, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ ok: false, error: 'Unauthorized' });
        }

        const user = await User.findByPk(req.user.id, {
            raw: true,
            attributes: ['api_key'],
        });

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        return res.status(200).json({
            message: 'API key fetched successfully',
            api_key: user.api_key || null,
        });
    } catch (error) {
        return res.status(500).json({ message: 'Error fetching API key', error });
    }
});

router.delete('/delete-api-key', requireSignIn, async (req, res) => {
    try {
        const user = await User.findByPk(req.user.id, { raw: true });

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        if (!user.api_key) {
            return res.status(404).json({ message: 'API Key not found' });
        }

        await User.update({ api_key: null }, { where: { id: req.user.id } });

        return res.status(200).json({ message: 'API Key deleted successfully' });
    } catch (error: any) {
        return res.status(500).json({ message: 'Error deleting API key', error: error.message });
    }
});

const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    // process.env.GOOGLE_REDIRECT_URI
);

// Step 1: Redirect to Google for authentication
router.get('/google', (req, res) => {
    const scopes = [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/drive.readonly',
    ];
    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',  // Ensures you get a refresh token on first login
        scope: scopes,
    });
    res.redirect(url);
});

// Step 2: Handle Google OAuth callback
router.get('/google/callback', async (req, res) => {
    const { code } = req.query;

    try {
        // Get access and refresh tokens
        if (typeof code !== 'string') {
            return res.status(400).json({ message: 'Invalid code' });
        }
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);

        // Get user profile from Google
        const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
        const { data: { email } } = await oauth2.userinfo.get();

        if (!email) {
            return res.status(400).json({ message: 'Email not found' });
        }

        // Check if user already exists
        let user = await User.findOne({ where: { email } });
        if (!user) {
            const hashedPassword = await hashPassword(email + process.env.JWT_SECRET);
            user = await User.create({
                email,
                password: hashedPassword,
                google_sheets_email: email, // Gmail used for Sheets
                google_access_token: tokens.access_token,
                google_refresh_token: tokens.refresh_token,
            });
        } else {
            // Update user's Google tokens if they exist
            await User.update({
                google_access_token: tokens.access_token,
                google_refresh_token: tokens.refresh_token,
            }, { where: { email } });
        }

        // List user's Google Sheets from their Google Drive
        const drive = google.drive({ version: 'v3', auth: oauth2Client });
        const response = await drive.files.list({
            q: "mimeType='application/vnd.google-apps.spreadsheet'", // List only Google Sheets files
            fields: 'files(id, name)',  // Retrieve the ID and name of each file
        });

        const files = response.data.files || [];
        if (files.length === 0) {
            return res.status(404).json({ message: 'No spreadsheets found.' });
        }

        // Generate JWT token for session
        const jwtToken = jwt.sign({ userId: user.id }, process.env.JWT_SECRET as string, { expiresIn: '12h' });
        res.cookie('token', jwtToken, { httpOnly: true });

        res.json({ 
            message: 'Google authentication successful', 
            email: user.email, 
            jwtToken, 
            files 
        });
    } catch (error: any) {
        res.status(500).json({ message: `Google OAuth error: ${error.message}` });
    }
});


// Step 3: Get data from Google Sheets
router.post('/gsheets/data', async (req, res) => {
    const { spreadsheetId } = req.body;
    const user = await User.findOne({ where: { id: req.user.id } });

    if (!user) {
        return res.status(400).json({ message: 'User not found' });
    }

    // Set Google OAuth credentials
    oauth2Client.setCredentials({
        access_token: user.google_access_token,
        refresh_token: user.google_refresh_token,
    });

    const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

    try {
        // Fetch data from the spreadsheet (you can let the user choose a specific range too)
        const sheetData = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: 'Sheet1!A1:D5',  // Default range, could be dynamic based on user input
        });
        res.json(sheetData.data);
    } catch (error: any) {
        res.status(500).json({ message: `Error accessing Google Sheets: ${error.message}` });
    }
});
