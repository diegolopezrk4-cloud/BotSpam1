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

    // Planes
    PLANES: {
        diario:  { dias: 1,  precio: "S/ 2.00",  emoji: "\u{1F949}" },
        semanal: { dias: 7,  precio: "S/ 10.00", emoji: "\u{1F948}" },
        mensual: { dias: 30, precio: "S/ 25.00", emoji: "\u{1F947}" },
    },

    // Sin limites (ilimitado)
    MAX_CUENTAS_POR_USUARIO: 999999,
    MAX_GRUPOS_POR_USUARIO: 999999,

    // Base de datos
    DB_PATH: "./wsp_titan.db",

    // Directorio de sesiones de cuentas de clientes
    SESSIONS_DIR: "./client_sessions",

    // Zona horaria (Peru = America/Lima = UTC-5)
    TIMEZONE: "America/Lima",
};
