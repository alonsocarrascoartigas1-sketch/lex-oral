require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const multer    = require('multer');
const path      = require('path');
const fs        = require('fs');
const Anthropic = require('@anthropic-ai/sdk');

const app       = express();
const port      = process.env.PORT || 3000;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'DELETE'] }));
app.use(express.json({ limit: '2mb' }));

const limiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_PER_HOUR) || 60,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes.' },
});
app.use('/api/', limiter);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

// ─── EXTRACCIÓN DE TEMAS ──────────────────────────────────────────────────────
function extraerTemas(topic) {
  var lineas = topic.split('\n')
    .map(function(l) { return l.trim(); })
    .filter(function(l) { return l.length > 15; });

  var temas = [];
  var pat = /^(clase|unidad|tema|cap[íi]tulo|secci[oó]n|\d+[\.\-\)])/i;

  lineas.forEach(function(l) {
    if (pat.test(l) || (l === l.toUpperCase() && l.length > 10 && l.length < 80)) {
      temas.push(l.substring(0, 80));
    }
  });

  if (temas.length < 3) {
    lineas.forEach(function(l) {
      if (l.length > 40 && l.length < 100 && temas.length < 8) {
        var p = l.split(' ').slice(0, 8).join(' ');
        if (!temas.includes(p)) temas.push(p);
      }
    });
  }
  return temas.slice(0, 12);
}

// ─── BLOQUE DE APUNTES CON TEMA ALEATORIO ────────────────────────────────────
function buildTopicBlock(topic) {
  // Sin nada — Derecho general
  if (!topic || topic.trim().length < 3) {
    return 'El alumno no ha cargado apuntes específicos. '
      + 'Evalúa Derecho general chileno: conceptos fundamentales, fuentes del derecho, '
      + 'acto jurídico, responsabilidad civil, derecho penal básico, derecho constitucional. '
      + 'Empieza con una pregunta amplia y fundamental.';
  }

  // Si es texto corto (un tema, no apuntes completos)
  if (topic.trim().length < 200) {
    var tema = topic.replace('[Apuntes: ]', '').trim();
    return 'El alumno quiere ser evaluado sobre el siguiente tema: "' + tema + '".\n\n'
      + 'Evalúa ese tema en profundidad usando tu conocimiento de Derecho chileno. '
      + 'Empieza con la definición más fundamental del tema y progresa hacia aspectos más complejos.';
  }

  // Apuntes completos
  var seed = Math.floor(Math.random() * 1000);
  var temas = extraerTemas(topic);
  var temaInicial = temas.length > 0 ? temas[seed % temas.length] : '';

  var bloque = '=== APUNTES DEL ALUMNO ===\n' + topic + '\n=== FIN DE APUNTES ===\n\n';

  if (temaInicial) {
    bloque += 'TEMA DE INICIO OBLIGATORIO: Empieza evaluando "' + temaInicial + '". '
      + 'Empieza con la pregunta más GENERAL posible sobre ese tema.\n\n';
  }

  bloque += 'REGLA: Solo pregunta sobre conceptos que aparezcan en los apuntes. '
    + 'PROHIBIDO inventar temas que no estén en el texto.';

  return bloque;
}

// ─── METODOLOGÍA DE EVALUACIÓN ORAL (COMÚN A TODOS) ─────────────────────────
var METODOLOGIA = '\n\n'
  + '=== METODOLOGIA DE EXAMEN ORAL DE DERECHO ===\n\n'
  + 'PROGRESION OBLIGATORIA por cada tema (en este orden):\n'
  + '  NIVEL 1 - Definicion: "Que es X?" / "Defina X" / "En que consiste X?"\n'
  + '  NIVEL 2 - Elementos: "Cuales son los elementos/requisitos/caracteristicas de X?"\n'
  + '  NIVEL 3 - Distincion: "Cual es la diferencia entre X e Y?"\n'
  + '  NIVEL 4 - Aplicacion: "En que caso se aplica X?" / "De un ejemplo de X"\n\n'
  + 'REGLAS DE PROGRESION:\n'
  + '- Siempre empieza por NIVEL 1. Nunca saltes al nivel 3 o 4 sin pasar por 1 y 2.\n'
  + '- Si el alumno responde bien un nivel, sube al siguiente nivel del mismo tema.\n'
  + '- Si el alumno responde mal o parcialmente, haz una pregunta mas facil sobre lo mismo antes de subir.\n'
  + '- Cuando el tema este agotado (niveles 1-3 evaluados), cambia a otro tema de los apuntes.\n'
  + '- NUNCA preguntes por citas textuales, autores especificos, numeros de articulos exactos ni paginas. Solo definiciones y conceptos.\n'
  + '- NUNCA repitas una pregunta ya hecha en esta sesion.\n'
  + '- Maximo 2-3 oraciones por turno. Solo espanol. Sin listas ni bullets.\n'
  + '=== FIN METODOLOGIA ===';

// ─── PERSONALIDADES ──────────────────────────────────────────────────────────
var PERSONAS = {

  rigorista: function(topicBlock, intensity) {
    return 'Eres el Dr. Rigorista, profesor titular de Derecho con 25 anos de docencia. '
      + 'Eres exigente pero justo. Hablas con autoridad y precision. '
      + 'Cuando el alumno se equivoca, dices cosas como "Eso no es correcto", "Le falta precision" o "Intente de nuevo". '
      + 'Cuando responde bien, asientes brevemente con "Correcto" o "Bien" y subes el nivel. '
      + 'No das pistas ni explicaciones, solo evaluas. '
      + 'Intensidad ' + intensity + '/5.\n\n'
      + topicBlock + METODOLOGIA;
  },

  dialéctico: function(topicBlock, intensity) {
    return 'Eres el Prof. Dialectico, profesor de Derecho que usa la interrogacion socratica. '
      + 'Nunca afirmas nada directamente: siempre respondes con otra pregunta que lleva al alumno a razonar. '
      + 'Si el alumno se equivoca, dices "Interesante... pero entonces, como explicaria usted que...?" '
      + 'Si responde bien, profundizas: "Muy bien. Y si eso es asi, que implicaria para el caso de...?" '
      + 'Tu objetivo es que el alumno llegue a las respuestas por su propio razonamiento. '
      + 'Intensidad ' + intensity + '/5.\n\n'
      + topicBlock + METODOLOGIA;
  },

  académico: function(topicBlock, intensity) {
    return 'Eres el Prof. Academico, docente pedagogico y estructurado. '
      + 'Cuando el alumno se equivoca, corriges con precision: "No exactamente. Recuerde que..." y das una pista. '
      + 'Cuando responde bien, refuerzas: "Exacto. Y eso se conecta con..." antes de la siguiente pregunta. '
      + 'Eres paciente pero exigente. Haces preguntas claras y bien formuladas. '
      + 'Tu tono es formal pero cercano, como un tutor universitario serio. '
      + 'Intensidad ' + intensity + '/5.\n\n'
      + topicBlock + METODOLOGIA;
  },

  socrático: function(topicBlock, intensity) {
    return 'Eres el Prof. Socratico, filosofo del Derecho que usa la mayeutica para que el alumno descubra la verdad. '
      + 'Haces preguntas que desafian supuestos: "Pero entonces, que es realmente la justicia en este caso?" '
      + 'Cuando el alumno responde bien, vas mas profundo: "Y si eso es cierto, como se justifica que...?" '
      + 'Cuando se equivoca, no corriges directamente: haces una pregunta que lo lleva a ver su propio error. '
      + 'Eres calmo, filosofico, y nunca te apresuras. '
      + 'Intensidad ' + intensity + '/5.\n\n'
      + topicBlock + METODOLOGIA;
  },

  examinador: function(topicBlock, intensity) {
    return 'Eres el Prof. Examinador, evaluador formal de un examen oral universitario real. '
      + 'El alumno esta frente al tribunal. Tu tono es completamente formal e impersonal. '
      + 'Usas "usted" siempre. Dices cosas como "Proceda", "Explique", "Continúe", "Siguiente pregunta". '
      + 'No das retroalimentacion durante el examen: solo anotas mentalmente la respuesta y sigues. '
      + 'Si el alumno responde mal, dices brevemente "Insuficiente. Pasamos a..." y cambias. '
      + 'Si responde bien, dices "Correcto. Siguiente:" y subes el nivel. '
      + 'Es la simulacion mas cercana a un examen oral real de facultad de Derecho. '
      + 'Intensidad ' + intensity + '/5.\n\n'
      + topicBlock + METODOLOGIA;
  },
};

// ─── CONSTRUIR SYSTEM PROMPT ──────────────────────────────────────────────────
function buildPrompt(prof, topic, intensity) {
  var topicBlock = buildTopicBlock(topic);
  var persona = PERSONAS[prof] || PERSONAS.rigorista;
  return persona(topicBlock, intensity);
}

// ─── HEALTH ───────────────────────────────────────────────────────────────────
app.get('/api/health', function(_, res) {
  res.json({ ok: true, version: '3.0.0', model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-5' });
});

// ─── UPLOAD ───────────────────────────────────────────────────────────────────
app.post('/api/upload', upload.single('file'), function(req, res) {
  if (!req.file) return res.status(400).json({ error: 'Sin archivo.' });
  try {
    var text = req.file.buffer.toString('utf-8').substring(0, 8000);
    res.json({ text: text, filename: req.file.originalname });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── CHAT ─────────────────────────────────────────────────────────────────────
app.post('/api/chat', async function(req, res) {
  var messages  = req.body.messages  || [];
  var prof      = req.body.prof      || 'rigorista';
  var intensity = req.body.intensity || 3;
  var topic     = req.body.topic     || '';
  var _system   = req.body._system   || null;

  if (messages.length > 80) return res.status(400).json({ error: 'Sesion muy larga.' });

  // El frontend puede mandar su propio system prompt ya construido
  var system = _system || buildPrompt(prof, topic.substring(0, 8000), intensity);

  // Sanear mensajes
  var raw = messages
    .map(function(m) {
      return {
        role: m.role === 'user' ? 'user' : 'assistant',
        content: String(m.content || '').substring(0, 2000).trim(),
      };
    })
    .filter(function(m) { return m.content.length > 0; });

  var sanitized = [];
  var last = null;
  for (var i = 0; i < raw.length; i++) {
    if (raw[i].role === last) continue;
    sanitized.push(raw[i]);
    last = raw[i].role;
  }
  if (!sanitized.length || sanitized[0].role !== 'user') {
    sanitized.unshift({ role: 'user', content: 'Comienza la prueba oral.' });
  }

  try {
    var response = await anthropic.messages.create({
      model:      process.env.CLAUDE_MODEL || 'claude-sonnet-4-5',
      max_tokens: parseInt(process.env.MAX_TOKENS) || 600,
      system:     system,
      messages:   sanitized,
    });

    res.json({
      reply:         response.content[0] ? response.content[0].text : '',
      input_tokens:  response.usage ? response.usage.input_tokens  : 0,
      output_tokens: response.usage ? response.usage.output_tokens : 0,
    });
  } catch(e) {
    console.error('[Claude]', e.status, e.message);
    if (e.status === 401) return res.status(500).json({ error: 'API Key invalida.' });
    if (e.status === 429) return res.status(429).json({ error: 'Limite de uso alcanzado.' });
    res.status(500).json({ error: e.message });
  }
});

// ─── FRONTEND ESTÁTICO ────────────────────────────────────────────────────────
var publicDir = path.join(__dirname, 'public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
  app.get('/{*path}', function(_, res) {
    res.sendFile(path.join(publicDir, 'index.html'));
  });
}

app.listen(port, function() {
  console.log('\nLex Oral Backend v3.0 — http://localhost:' + port);
  console.log('  Claude : ' + (process.env.CLAUDE_MODEL || 'claude-sonnet-4-5'));
  console.log('  Personalidades reforzadas: 5 evaluadores\n');
});