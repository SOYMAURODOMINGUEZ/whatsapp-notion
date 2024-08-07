const { Client: NotionClient } = require("@notionhq/client");
const { subMinutes } = require("date-fns");
const { Client: WhatsAppClient, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const readline = require('readline');

// Inicializar el cliente de Notion
const notion = new NotionClient({
  auth: "secret_oa6RKbWhiAAKZwU4GYcqfarsPRC1CcORWTcQlMuAT6J"
});

// IDs de las bases de datos
const contactsDatabaseId = "f0725ce14f064ef8b265c318331ac670";
const historyDatabaseId = "211b3042bc1b43d2a88a2eb4037b46a2";

// Inicializar el cliente de WhatsApp
let client;
const firstMessageTimestamps = new Map();
const transcriptions = new Map(); // Almacena las transcripciones pendientes

const initializeClient = (headlessMode) => {
  client = new WhatsAppClient({
    authStrategy: new LocalAuth(),
    puppeteer: { headless: headlessMode, args: ['--no-sandbox', '--disable-setuid-sandbox'] },
  });

  client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
    console.log('Escanea el código QR con tu aplicación de WhatsApp.');
  });

  client.on('ready', () => {
    console.log('Cliente de WhatsApp listo.');
    monitorDatabase("somos@iemcompany@gmail.com"); // Monitoriza la base de datos con el correo predeterminado
  });

  client.on('authenticated', () => {
    console.log('Cliente de WhatsApp autenticado.');
  });

  client.on('auth_failure', (msg) => {
    console.error('Fallo de autenticación en WhatsApp:', msg);
  });

  client.on('disconnected', (reason) => {
    console.log('Cliente de WhatsApp desconectado:', reason);
  });

  client.on('message', async (message) => {
    if (message.type === 'status') return;

    const from = message.from;
    const body = message.body;
    const isGroupMsg = message.isGroupMsg;
    const fromId = isGroupMsg ? message.from : from.split('@')[0];
    const whatsappUrl = `https://api.whatsapp.com/send?phone=${fromId}`;

    console.log(`Mensaje recibido de ${fromId}`);

    if (message.hasMedia && message.mimetype && (message.type === 'audio' || message.mimetype.includes('audio'))) {
      const media = await message.downloadMedia();
      console.log('Audio recibido. Reenviando al contacto específico.');

      await client.sendMessage('5491153495987@c.us', media, {
        caption: 'Reenviando audio recibido.'
      });

      transcriptions.set(message.id._serialized, fromId); // Almacena el ID del mensaje de audio
    } else if (transcriptions.has(message.quotedMsgId)) {
      const originalSender = transcriptions.get(message.quotedMsgId);
      transcriptions.delete(message.quotedMsgId);

      console.log(`Transcripción recibida para el audio de ${originalSender}: ${body}`);

      const contactPageId = await getOrCreateContactPageId(originalSender, `https://api.whatsapp.com/send?phone=${originalSender}`);
      const integratedDbId = await ensureIntegratedDatabase(contactPageId);
      const contactName = await getContactName(contactPageId, originalSender);

      await createMessageRecord(integratedDbId, body, contactPageId, contactName);
      await createMessageRecord(historyDatabaseId, body, contactPageId, contactName);
      
      console.log("Transcripción registrada correctamente.");
    } else {
      try {
        const contactPageId = await getOrCreateContactPageId(fromId, whatsappUrl);
        const integratedDbId = await ensureIntegratedDatabase(contactPageId);
        const contactName = await getContactName(contactPageId, fromId);

        await createMessageRecord(integratedDbId, body, contactPageId, contactName);
        await createMessageRecord(historyDatabaseId, body, contactPageId, contactName);
        
        console.log("Registros creados correctamente.");
      } catch (error) {
        console.error("Error al manejar el mensaje entrante:", error);
      }
    }
  });

  client.initialize();
  console.log('Cliente de WhatsApp inicializado.');
};

initializeClient(false);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

rl.question('Presiona Enter para cambiar a modo headless...', () => {
  rl.close();
  console.log('Cambiando a modo headless...');
  client.destroy().then(() => {
    initializeClient(true);
  }).catch(err => {
    console.error('Error al destruir el cliente de WhatsApp:', err);
  });
});

async function monitorDatabase(email) {
  while (true) {
    try {
      const now = new Date();
      const twoMinutesAgo = subMinutes(now, 2).toISOString();

      const response = await notion.databases.query({
        database_id: contactsDatabaseId,
        filter: {
          property: "Última edición",
          date: { after: twoMinutesAgo }
        },
        sorts: [
          { property: "Última edición", direction: "descending" }
        ],
        page_size: 10
      });

      for (const page of response.results) {
        const whatsappUrl = page.properties.WHATSAPP?.url || "";
        const setters = page.properties.SETTER?.people || [];
        const editorEmail = setters[0]?.person?.email || "";

        if (editorEmail !== email) continue;

        const envioTextEsp = page.properties["ENVIAR"]?.rich_text[0]?.text?.content || "";
        const envioTextIng = page.properties["ENVIAR_INGLES"]?.rich_text[0]?.text?.content || "";
        const firstMessageDate = page.properties["ENVIO_WP"]?.date?.start || "";

        if (whatsappUrl && (envioTextEsp || envioTextIng) && firstMessageDate) {
          const phoneNumber = whatsappUrl.split('phone=')[1];
          const formattedPhoneNumber = phoneNumber + '@c.us';

          if (firstMessageTimestamps.has(formattedPhoneNumber)) {
            const previousFirstMessageDate = firstMessageTimestamps.get(formattedPhoneNumber);
            if (previousFirstMessageDate === firstMessageDate) {
              console.log(`Mensaje no enviado a ${formattedPhoneNumber} porque la fecha es la misma que la del mensaje anterior.`);
              continue;
            }
          }

          firstMessageTimestamps.set(formattedPhoneNumber, firstMessageDate);

          let messagesToSend = [];

          if (envioTextEsp) {
            console.log(`Enviando mensaje en español a: ${formattedPhoneNumber}`);
            messagesToSend.push(envioTextEsp);
            await client.sendMessage(formattedPhoneNumber, envioTextEsp);
            console.log(`Mensaje en español enviado correctamente a ${formattedPhoneNumber}`);
            await saveSentMessage(envioTextEsp, formattedPhoneNumber, "Gabriel Miguel");
          }

          if (envioTextIng) {
            console.log(`Enviando mensaje en inglés a: ${formattedPhoneNumber}`);
            messagesToSend.push(envioTextIng);
            await client.sendMessage(formattedPhoneNumber, envioTextIng);
            console.log(`Mensaje en inglés enviado correctamente a ${formattedPhoneNumber}`);
            await saveSentMessage(envioTextIng, formattedPhoneNumber, "Gabriel Miguel");
          }

          const historialProperty = "HISTORIAL";
          const currentHistorial = page.properties[historialProperty]?.rich_text[0]?.text?.content || "";
          const newHistorial = messagesToSend.map(msg => `Gabriel: ${msg}`).join('\n\n');

          await notion.pages.update({
            page_id: page.id,
            properties: {
              [historialProperty]: {
                rich_text: [{ text: { content: `${currentHistorial}\n\n${newHistorial}` } }]
              }
            }
          });
        }
      }

      let seconds = 10;
      while (seconds > 0) {
        process.stdout.write(`Esperando ${seconds} segundos para el siguiente monitoreo...\r`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        seconds--;
      }
      console.log('');
    } catch (error) {
      console.error("Error al consultar la base de datos:", error);
    }
  }
}

async function getOrCreateContactPageId(fromId, whatsappUrl) {
  try {
    const contactResponse = await notion.databases.query({
      database_id: contactsDatabaseId,
      filter: {
        property: "WHATSAPP",
        url: {
          contains: fromId
        }
      }
    });

    if (contactResponse.results.length === 0) {
      const newContactPage = await notion.pages.create({
        parent: { database_id: contactsDatabaseId },
        properties: {
          "WHATSAPP": { url: whatsappUrl },
          "Name": { title: [{ text: { content: fromId } }] }
        }
      });
      console.log("Nuevo registro de contacto creado en la base de datos.");
      return newContactPage.id;
    } else {
      return contactResponse.results[0].id;
    }
  } catch (error) {
    console.error("Error al crear o obtener el ID de la página de contacto:", error);
    throw error;
  }
}

async function ensureIntegratedDatabase(pageId) {
  try {
    const blocks = await notion.blocks.children.list({ block_id: pageId });

    for (const block of blocks.results) {
      if (block.type === 'child_database') {
        return block.id;
      }
    }

    const newDatabase = await notion.databases.create({
      parent: { page_id: pageId },
      title: [{ type: 'text', text: { content: 'Mensajes' } }],
      properties: {
        "MENSAJE": { type: "rich_text" },
        "RELACION": { type: "relation", relation: { database_id: contactsDatabaseId } },
        "Name": { type: "title" }
      }
    });

    return newDatabase.id;
  } catch (error) {
    console.error("Error al asegurar la base de datos integrada:", error);
    throw error;
  }
}

async function getContactName(contactPageId, fromId) {
  try {
    const contactPage = await notion.pages.retrieve({ page_id: contactPageId });
    return contactPage.properties.Name?.title?.[0]?.text?.content || fromId;
  } catch (error) {
    console.error("Error al obtener el nombre del contacto:", error);
    throw error;
  }
}

async function createMessageRecord(databaseId, message, contactPageId, contactName) {
  try {
    await notion.pages.create({
      parent: { database_id: databaseId },
      properties: {
        "MENSAJE": { rich_text: [{ text: { content: message } }] },
        "RELACION": { relation: [{ id: contactPageId }] },
        "Name": { title: [{ text: { content: contactName } }] }
      }
    });
  } catch (error) {
    console.error("Error al crear el registro del mensaje:", error);
    throw error;
  }
}

async function saveSentMessage(message, formattedPhoneNumber, senderName) {
  try {
    const whatsappUrl = `https://api.whatsapp.com/send?phone=${formattedPhoneNumber.split('@')[0]}`;
    const contactPageId = await getOrCreateContactPageId(formattedPhoneNumber.split('@')[0], whatsappUrl);
    const integratedDbId = await ensureIntegratedDatabase(contactPageId);

    await createMessageRecord(integratedDbId, message, contactPageId, senderName);
    await createMessageRecord(historyDatabaseId, message, contactPageId, senderName);

    console.log("Mensaje enviado registrado correctamente.");
  } catch (error) {
    console.error("Error al registrar el mensaje enviado:", error);
    throw error;
  }
}
