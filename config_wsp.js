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
        semanal: { dias: 7,  precio: "S/ 15.00", precio_usdt: 4.00,  emoji: "\u{1F948}" },
        mensual: { dias: 30, precio: "S/ 30.00", precio_usdt: 8.00,  emoji: "\u{1F947}" },
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
};
