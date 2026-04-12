-- ============================================================
-- Oiikon WhatsApp Agent — Supabase Schema
-- ============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- TABLES
-- ============================================================

-- Conversations table
CREATE TABLE conversations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  phone_number TEXT NOT NULL UNIQUE,
  customer_name TEXT,
  customer_segment TEXT, -- 'cuban_family', 'general', 'unknown'
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'escalated', 'closed')),
  escalated BOOLEAN DEFAULT FALSE,
  escalation_reason TEXT,
  product_interest TEXT, -- last product they asked about
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Messages table
CREATE TABLE messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  handoff_detected BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Products table (Sol queries this for real-time prices/stock)
CREATE TABLE products (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  sku TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL, -- 'portable_station', 'battery', 'inverter', 'panel', 'all_in_one', 'accessory'
  brand TEXT NOT NULL,
  capacity_wh INTEGER,
  output_watts INTEGER,
  price_usd DECIMAL(10,2) NOT NULL,
  price_includes_cuba_shipping BOOLEAN DEFAULT TRUE,
  in_stock BOOLEAN DEFAULT TRUE,
  description_es TEXT,
  ideal_for TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Handoff log table
CREATE TABLE handoffs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  conversation_id UUID REFERENCES conversations(id),
  reason TEXT NOT NULL,
  last_customer_message TEXT,
  resolved BOOLEAN DEFAULT FALSE,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX idx_messages_conversation_id ON messages(conversation_id);
CREATE INDEX idx_conversations_phone_number ON conversations(phone_number);
CREATE INDEX idx_conversations_status ON conversations(status);
CREATE INDEX idx_conversations_escalated ON conversations(escalated);
CREATE INDEX idx_messages_created_at ON messages(created_at);

-- ============================================================
-- UPDATED_AT TRIGGER
-- ============================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_conversations_updated_at
  BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_products_updated_at
  BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================================

ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE handoffs ENABLE ROW LEVEL SECURITY;

-- Service role bypass (backend operations)
CREATE POLICY "Service role full access on conversations"
  ON conversations FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access on messages"
  ON messages FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access on products"
  ON products FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access on handoffs"
  ON handoffs FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Authenticated users can read all tables (dashboard)
CREATE POLICY "Authenticated users can read conversations"
  ON conversations FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can update conversations"
  ON conversations FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated users can read messages"
  ON messages FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can read products"
  ON products FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can update products"
  ON products FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated users can read handoffs"
  ON handoffs FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can update handoffs"
  ON handoffs FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

-- ============================================================
-- REALTIME (enable for live dashboard updates)
-- ============================================================
-- Run these in the Supabase dashboard or via the API:
-- ALTER PUBLICATION supabase_realtime ADD TABLE conversations;
-- ALTER PUBLICATION supabase_realtime ADD TABLE messages;

-- ============================================================
-- SEED DATA — PRODUCT CATALOG
-- ============================================================

-- Estaciones de Energía Portátiles PECRON
INSERT INTO products (sku, name, category, brand, capacity_wh, output_watts, price_usd, price_includes_cuba_shipping, in_stock, description_es, ideal_for) VALUES
('PECRON-E300LFP', 'PECRON E300LFP', 'portable_station', 'PECRON', 288, 300, 189.00, true, true,
 'Estación de energía portátil PECRON E300LFP con batería LiFePO4. Compacta y ligera, perfecta para viajes o emergencias.',
 'Luces + carga de celulares'),

('PECRON-E500LFP', 'PECRON E500LFP', 'portable_station', 'PECRON', 576, 600, 250.00, true, true,
 'Estación de energía portátil PECRON E500LFP con batería LiFePO4. Ideal para mantener luces y ventiladores pequeños.',
 'Luces + ventilador pequeño'),

('PECRON-F1000LFP', 'PECRON F1000LFP', 'portable_station', 'PECRON', 1004, 1500, 427.00, true, true,
 'Estación de energía portátil PECRON F1000LFP con batería LiFePO4 y salida de 1,500W. Puede con una nevera pequeña.',
 'Nevera pequeña + luces (4-5 hrs)'),

('PECRON-E1500LFP', 'PECRON E1500LFP', 'portable_station', 'PECRON', 1536, 2200, 622.00, true, true,
 'Estación de energía portátil PECRON E1500LFP con batería LiFePO4 y salida de 2,200W. Potencia suficiente para nevera, luces y TV.',
 'Nevera + luces + TV (5-6 hrs)'),

('PECRON-E2400LFP', 'PECRON E2400LFP', 'portable_station', 'PECRON', 2048, 2400, 770.00, true, true,
 'El best-seller de Oiikon. PECRON E2400LFP con 2,048Wh y salida de 2,400W. El equilibrio perfecto entre capacidad, potencia y precio para la familia cubana.',
 'Best-seller. Nevera + ventilador + luces (7-8 hrs)'),

('PECRON-F3000LFP', 'PECRON F3000LFP', 'portable_station', 'PECRON', 3072, 3600, 1030.00, true, true,
 'Estación de energía portátil PECRON F3000LFP con 3,072Wh y salida de 3,600W. Para hogares con múltiples aparatos.',
 'Nevera + múltiples aparatos (8-10 hrs)'),

('PECRON-E3600LFP', 'PECRON E3600LFP', 'portable_station', 'PECRON', 3840, 3600, 1341.00, true, true,
 'PECRON E3600LFP: máxima capacidad en formato portátil. 3,840Wh y 3,600W. Maneja toda una casa sin AC durante 10-12 horas.',
 'Casa completa sin AC (10-12 hrs)'),

('PECRON-E3800LFP', 'PECRON E3800LFP', 'portable_station', 'PECRON', 3840, 4200, 1453.00, true, true,
 'PECRON E3800LFP: 3,840Wh con salida de 4,200W — mayor potencia de salida que el E3600. Ideal cuando la nevera es de compresor viejo y necesita más watts de arranque.',
 'Casa completa, mayor potencia de salida'),

('PECRON-F5000LFP', 'PECRON F5000LFP', 'portable_station', 'PECRON', 5120, 7200, 2396.00, true, true,
 'PECRON F5000LFP: el más potente de la línea portátil. 5,120Wh y 7,200W de salida. Salida dual 120V/240V. Mini sistema de respaldo.',
 'Mini sistema de respaldo. 120V/240V dual.'),

('PECRON-E3600X2', 'PECRON E3600LFP x2 Kit', 'portable_station', 'PECRON', 7680, 7200, 3197.00, true, true,
 'Kit de dos PECRON E3600LFP conectados en paralelo. 7,680Wh totales con salida de 7,200W y compatibilidad 220V. La solución portátil más completa del catálogo.',
 'Máxima capacidad portátil. Kit 220V.');

-- Baterías de Litio (requieren inversor)
INSERT INTO products (sku, name, category, brand, capacity_wh, output_watts, price_usd, price_includes_cuba_shipping, in_stock, description_es, ideal_for) VALUES
('PECRON-WB12200', 'PECRON WB12200 12V 200Ah LiFePO4', 'battery', 'PECRON', 2560, NULL, 568.45, true, true,
 'Batería LiFePO4 de 12V 200Ah (2,560Wh). Ideal para instalación fija con inversor de 12V.',
 'Instalación fija con inversor 12V'),

('WATT-12V100', 'WATT 12V 100Ah', 'battery', 'WATT', 1280, NULL, 293.00, true, true,
 'Batería de 12V 100Ah (1,280Wh) para instalación fija con inversor.',
 'Instalación básica con inversor 12V'),

('ECO-48V280', 'ECO-WORTHY 48V 280Ah', 'battery', 'ECO-WORTHY', 14336, NULL, 2490.00, true, true,
 'Banco de baterías de gran capacidad 48V 280Ah (14,336Wh). Para sistemas solares residenciales de alta demanda.',
 'Sistema solar residencial completo'),

('SUNPAL-Y4-10K', 'Sunpal Powerpal Y4 10kWh', 'battery', 'Sunpal', 10000, NULL, 1238.37, true, true,
 'Batería LiFePO4 de 51.2V 10kWh (Powerpal Y4). Diseñada para sistemas de respaldo residencial de larga duración.',
 'Respaldo residencial 51.2V'),

('SUNPAL-Y4-5K', 'Sunpal Powerpal Y4 5kWh', 'battery', 'Sunpal', 5000, NULL, 418.65, true, true,
 'Batería LiFePO4 de 51.2V 5kWh (Powerpal Y4). Versión compacta del sistema de respaldo residencial.',
 'Respaldo residencial compacto 51.2V'),

('HUMSIENK-48V100', 'Humsienk 48V 100Ah Rack 3U', 'battery', 'Humsienk', 5000, NULL, 1122.75, true, true,
 'Batería rack 3U de 48V 100Ah (5,000Wh). Formato rack para instalaciones técnicas organizadas.',
 'Instalación rack residencial o comercial'),

('SUNGOLD-PWX', 'SunGold Power Powerwall X 10.24kWh', 'battery', 'SunGold Power', 10240, NULL, 2940.00, true, true,
 'Powerwall X de SunGold Power: 51.2V 10.24kWh. Sistema de almacenamiento tipo powerwall para instalación en pared.',
 'Powerwall residencial estilo Tesla');

-- Inversores Solares
INSERT INTO products (sku, name, category, brand, capacity_wh, output_watts, price_usd, price_includes_cuba_shipping, in_stock, description_es, ideal_for) VALUES
('SG-3024A', 'SunGold Power SPH3024 80A', 'inverter', 'SunGold Power', NULL, 3000, 731.00, true, true,
 'Inversor-cargador solar híbrido SPH3024 de SunGold Power: 3,000W, 24V. Compatible con baterías de 24V.',
 'Sistema solar híbrido 24V hasta 3kW'),

('SG-5048P', 'SunGold Power SPH5048P', 'inverter', 'SunGold Power', NULL, 5000, 1200.00, true, true,
 'Inversor-cargador solar híbrido SPH5048P de SunGold Power: 5,000W, 48V.',
 'Sistema solar híbrido 48V hasta 5kW'),

('SG-8048P', 'SunGold Power SPH8048P', 'inverter', 'SunGold Power', NULL, 8000, 1773.00, true, true,
 'Inversor-cargador solar híbrido SPH8048P de SunGold Power: 8,000W, 48V. Para cargas pesadas.',
 'Sistema solar híbrido 48V hasta 8kW'),

('SG-6548P', 'SunGold Power SPH6548P', 'inverter', 'SunGold Power', NULL, 6500, 1500.00, true, true,
 'Inversor-cargador solar híbrido SPH6548P de SunGold Power: 6,500W, 48V.',
 'Sistema solar híbrido 48V hasta 6.5kW'),

('ECO-5048', 'ECO-WORTHY 5000W Split Phase', 'inverter', 'ECO-WORTHY', NULL, 5000, 1100.00, true, true,
 'Inversor solar ECO-WORTHY de 5,000W con salida Split Phase (120V/240V), 48V. Compatible con la red eléctrica estándar de USA.',
 'Sistema solar split phase 48V'),

('ECO-3024', 'ECO-WORTHY 3000W Combo', 'inverter', 'ECO-WORTHY', NULL, 3000, 680.00, true, true,
 'Inversor-cargador solar ECO-WORTHY de 3,000W, 24V. Kit combo con controlador MPPT incluido.',
 'Sistema solar combo 24V hasta 3kW'),

('SRNE-10K', 'SRNE SPI-10K-UP Split Phase', 'inverter', 'SRNE', NULL, 10000, 1470.29, true, true,
 'Inversor solar SRNE SPI-10K-UP: 10,000W Split Phase (120V/240V), 48V. Para instalaciones residenciales de alta potencia.',
 'Sistema solar residencial 10kW split phase');

-- Paneles Solares PECRON
INSERT INTO products (sku, name, category, brand, capacity_wh, output_watts, price_usd, price_includes_cuba_shipping, in_stock, description_es, ideal_for) VALUES
('PECRON-PNL100', 'PECRON Flexible Monocristalino 100W', 'panel', 'PECRON', NULL, 100, 145.00, true, true,
 'Panel solar flexible monocristalino PECRON de 100W. Se dobla hasta 30 grados, ideal para superficies curvas o techos irregulares.',
 'Recarga portátil o instalación flexible'),

('PECRON-PNL200', 'PECRON Flexible Monocristalino 200W', 'panel', 'PECRON', NULL, 200, 265.00, true, true,
 'Panel solar flexible monocristalino PECRON de 200W. Doble capacidad de generación en el mismo formato flexible.',
 'Recarga estación portátil o sistema pequeño'),

('PECRON-PNL300', 'PECRON Flexible Monocristalino 300W', 'panel', 'PECRON', NULL, 300, 374.00, true, true,
 'Panel solar flexible monocristalino PECRON de 300W. La opción de mayor generación en formato flexible.',
 'Recarga rápida o sistema solar portátil');

-- Sistemas Todo-en-Uno
INSERT INTO products (sku, name, category, brand, capacity_wh, output_watts, price_usd, price_includes_cuba_shipping, in_stock, description_es, ideal_for) VALUES
('SUNPAL-FUT3K', 'Sunpal Futuro 3kW', 'all_in_one', 'Sunpal', NULL, 3000, 5232.00, true, true,
 'Sistema solar completo Sunpal Futuro 3kW: incluye inversor, baterías y paneles. Instalación profesional requerida.',
 'Sistema solar residencial completo 3kW'),

('OIIKON-TITAN10K', 'Oiikon TITAN 10K', 'all_in_one', 'Oiikon', 14336, 10000, 7525.00, true, true,
 'El sistema solar más completo de Oiikon: inversor 10kW + batería 14.3kWh + 8 paneles de 700W. Instalación profesional requerida. Ideal para casas con alta demanda.',
 'Casa completa con AC. Inversor 10kW + Batería 14.3kWh + 8 Paneles 700W');

-- Accesorios
INSERT INTO products (sku, name, category, brand, capacity_wh, output_watts, price_usd, price_includes_cuba_shipping, in_stock, description_es, ideal_for) VALUES
('PECRON-TROLLEY', 'PECRON Trolley', 'accessory', 'PECRON', NULL, NULL, 134.00, true, true,
 'Carrito PECRON Trolley: diseñado para transportar fácilmente las estaciones de energía portátiles PECRON. Compatible con modelos E1500-E3800.',
 'Transporte fácil de estaciones PECRON E1500-E3800');
