import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { SpeedInsights } from "@vercel/speed-insights/react"
import { inject } from '@vercel/analytics';

inject();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
    {/* 👇 Añade aquí SpeedInsights */}
    <SpeedInsights />
  </StrictMode>,
)
