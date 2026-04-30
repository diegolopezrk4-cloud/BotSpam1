module.exports = {
    // Numero del admin (con codigo de pais, sin +)
    // Formato: "51987654321" (Peru = 51)
    ADMIN_NUMBER: "51976680776",

    // Telegram IDs de admins (para el panel web)
    ADMIN_TELEGRAM_IDS: ["8001675901"],

    // Numero del bot (para darle membresia ilimitada)
    BOT_NUMBER: "51907394660",

    // Numero de Yape para pagos
    YAPE_NUM: "9776680776",

    // Planes (precios en Soles y USDT)
    PLANES: {
        diario:  { dias: 1,  precio: "S/ 2.00",  precio_usdt: 0.55,  emoji: "\u{1F949}" },
        semanal: { dias: 7,  precio: "S/ 10.00", precio_usdt: 2.70,  emoji: "\u{1F948}" },
        mensual: { dias: 30, precio: "S/ 25.00", precio_usdt: 6.75,  emoji: "\u{1F947}" },
    },

    // Binance Pay (Merchant API)
    // Obtener keys en: https://merchant.binance.com → Developer → API Keys
    BINANCE_PAY: {
        API_KEY: "",
        API_SECRET: "",
        // URL base de la API de Binance Pay
        BASE_URL: "https://bpay.binanceapi.com",
        // Nombre del merchant que se muestra al pagar
        MERCHANT_NAME: "J&D Bot",
        // Moneda de pago
        CURRENCY: "USDT",
        // Tiempo de expiración de la orden en minutos
        ORDER_EXPIRY_MINUTES: 30,
    },

    // Limites
    MAX_CUENTAS_POR_USUARIO: 5,
    MAX_GRUPOS_POR_USUARIO: 25,

    // Base de datos
    DB_PATH: "./wsp_titan.db",

    // Directorio de sesiones de cuentas de clientes
    SESSIONS_DIR: "./client_sessions",

    // Zona horaria (Peru = America/Lima = UTC-5)
    TIMEZONE: "America/Lima",

    // --- MEJORAS FUTURAS (Implementadas) ---

    // 3. Web Push Notifications (VAPID)
    // Generar con: npx web-push generate-vapid-keys
    VAPID: {
        PUBLIC_KEY: "",
        PRIVATE_KEY: "",
        SUBJECT: "mailto:admin@jdbot.com",
    },

    // 7. Deteccion de ban preventiva
    BAN_DETECTION: {
        WINDOW_MINUTES: 10,
        MAX_FAILURES: 15,
        AUTO_PAUSE_MINUTES: 30,
    },

    // 12. Programacion recurrente (cron-like)
    CRON_CHECK_INTERVAL_MS: 60000,

    // 15. Respaldo automatico diario
    AUTO_BACKUP: {
        ENABLED: true,
        HOUR: 3,
        MINUTE: 0,
        KEEP_DAYS: 7,
        DIR: "./backups",
    },

    // 16. Google Sheets (opcional)
    GOOGLE_SHEETS: {
        API_KEY: "",
        CLIENT_EMAIL: "",
        PRIVATE_KEY: "",
    },

    // 18. Rate limiting adaptativo
    ADAPTIVE_RATE: {
        ENABLED: true,
        MIN_DELAY_MS: 3000,
        MAX_DELAY_MS: 30000,
        FAILURE_THRESHOLD: 0.3,
        CHECK_WINDOW: 20,
    },

    // 23. Monitoreo con alertas
    MONITORING: {
        HEALTH_CHECK_INTERVAL_MS: 60000,
        ALERT_WEBHOOK_URL: "",
    },

    // Directorio de comprobantes de pago
    COMPROBANTES_DIR: "./comprobantes",
};
