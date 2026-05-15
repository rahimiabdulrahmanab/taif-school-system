# Taif High School Management System

Built by Rahimi Tech Solution — Jalalabad, Afghanistan

## Development

```bash
# Install dependencies
npm install

# Run in development (browser only)
npm run dev

# Run as Electron desktop app
npm start
```

## Build Windows .exe

```bash
# Build installer
npm run build:win
```

The installer will be in the `dist/` folder.

## Requirements

- Node.js v18+
- PostgreSQL 14+
- Windows 10/11 (for .exe build)

## Database Setup

1. Create a PostgreSQL database named `taif_school`
2. Copy `.env.example` to `.env` and fill in your DB credentials
3. Run `db/schema.sql` to create the tables

## Contact

Rahimi Tech Solution  
Phone: +93 767 617 184  
Email: info@rahimitechsolution.com
