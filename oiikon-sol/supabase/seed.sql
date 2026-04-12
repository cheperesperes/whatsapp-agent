-- Oiikon WhatsApp Agent - Product Seed Data
-- This file populates the products table with inventory

-- PORTABLE STATIONS (PECRON)
INSERT INTO products (sku, name, category, brand, capacity_wh, output_watts, price_usd, price_includes_cuba_shipping, in_stock, ideal_for) VALUES
('PECRON-E300LFP', 'PECRON E300LFP', 'portable_station', 'PECRON', 288, 300, 189.00, true, true, 'Luces + carga de celulares'),
('PECRON-E500LFP', 'PECRON E500LFP', 'portable_station', 'PECRON', 576, 600, 250.00, true, true, 'Luces + ventilador pequeño'),
('PECRON-F1000LFP', 'PECRON F1000LFP', 'portable_station', 'PECRON', 1004, 1500, 427.00, true, true, 'Nevera pequeña + luces (4-5 hrs)'),
('PECRON-E1500LFP', 'PECRON E1500LFP', 'portable_station', 'PECRON', 1536, 2200, 622.00, true, true, 'Nevera + luces + TV (5-6 hrs)'),
('PECRON-E2400LFP', 'PECRON E2400LFP', 'portable_station', 'PECRON', 2048, 2400, 770.00, true, true, 'Best-seller. Nevera + ventilador + luces (7-8 hrs)'),
('PECRON-F3000LFP', 'PECRON F3000LFP', 'portable_station', 'PECRON', 3072, 3600, 1030.00, true, true, 'Nevera + múltiples aparatos (8-10 hrs)'),
('PECRON-E3600LFP', 'PECRON E3600LFP', 'portable_station', 'PECRON', 3840, 3600, 1341.00, true, true, 'Casa completa sin AC (10-12 hrs)'),
('PECRON-E3800LFP', 'PECRON E3800LFP', 'portable_station', 'PECRON', 3840, 4200, 1453.00, true, true, 'Casa completa, mayor potencia'),
('PECRON-F5000LFP', 'PECRON F5000LFP', 'portable_station', 'PECRON', 5120, 7200, 2396.00, true, true, 'Mini sistema de respaldo 120V/240V'),
('PECRON-E3600LFP-KIT-2', 'PECRON E3600LFP x2 Kit', 'portable_station', 'PECRON', 7680, 7200, 3197.00, true, true, 'Máxima capacidad portátil, Kit 220V');

-- BATTERIES
INSERT INTO products (sku, name, category, brand, capacity_wh, output_watts, price_usd, price_includes_cuba_shipping, in_stock) VALUES
('PECRON-WB12200', 'PECRON WB12200', 'battery', 'PECRON', 2560, NULL, 568.45, true, true),
('WATT-12V100AH', 'WATT 12V 100Ah', 'battery', 'WATT', 1280, NULL, 293.00, true, true),
('ECOWORTHY-48V280AH', 'ECO-WORTHY 48V 280Ah', 'battery', 'ECO-WORTHY', 14336, NULL, 2490.00, true, true),
('SUNPAL-Y4-10KWH', 'Sunpal Powerpal Y4 10kWh', 'battery', 'Sunpal', 10000, NULL, 1238.37, true, true),
('SUNPAL-Y4-5KWH', 'Sunpal Powerpal Y4 5kWh', 'battery', 'Sunpal', 5000, NULL, 418.65, true, true),
('HUMSIENK-48V100AH', 'Humsienk 48V 100Ah Rack', 'battery', 'Humsienk', 5000, NULL, 1122.75, true, true),
('SUNGOLD-POWERWALL-X', 'SunGold Powerwall X 10.24kWh', 'battery', 'SunGold Power', 10240, NULL, 2940.00, true, true);

-- INVERTERS
INSERT INTO products (sku, name, category, brand, capacity_wh, output_watts, price_usd, price_includes_cuba_shipping, in_stock) VALUES
('SUNGOLD-SPH302480A', 'SunGold SPH302480A', 'inverter', 'SunGold Power', NULL, 3000, 731.00, true, true),
('SUNGOLD-SPH5048P', 'SunGold SPH5048P', 'inverter', 'SunGold Power', NULL, 5000, 1200.00, true, true),
('SUNGOLD-SPH8048P', 'SunGold SPH8048P', 'inverter', 'SunGold Power', NULL, 8000, 1773.00, true, true),
('SUNGOLD-SPH6548P', 'SunGold SPH6548P', 'inverter', 'SunGold Power', NULL, 6500, 1500.00, true, true),
('ECOWORTHY-5KW-SPLIT', 'ECO-WORTHY 5000W Split Phase', 'inverter', 'ECO-WORTHY', NULL, 5000, 1100.00, true, true),
('ECOWORTHY-3KW-COMBO', 'ECO-WORTHY 3000W Combo', 'inverter', 'ECO-WORTHY', NULL, 3000, 680.00, true, true),
('SRNE-SPI-10K-UP', 'SRNE SPI-10K-UP', 'inverter', 'SRNE', NULL, 10000, 1470.29, true, true);

-- PANELS
INSERT INTO products (sku, name, category, brand, capacity_wh, output_watts, price_usd, price_includes_cuba_shipping, in_stock) VALUES
('PECRON-FLEX-100W', 'PECRON Flexible 100W', 'panel', 'PECRON', NULL, 100, 145.00, true, true),
('PECRON-FLEX-200W', 'PECRON Flexible 200W', 'panel', 'PECRON', NULL, 200, 265.00, true, true),
('PECRON-FLEX-300W', 'PECRON Flexible 300W', 'panel', 'PECRON', NULL, 300, 374.00, true, true);

-- ALL-IN-ONE SYSTEMS
INSERT INTO products (sku, name, category, brand, capacity_wh, output_watts, price_usd, price_includes_cuba_shipping, in_stock) VALUES
('SUNPAL-FUTURO-3KW', 'Sunpal Futuro 3kW', 'all_in_one_system', 'Sunpal', NULL, 3000, 5232.00, true, true),
('OIIKON-TITAN-10K', 'Oiikon TITAN 10K', 'all_in_one_system', 'Oiikon', NULL, 10000, 7525.00, true, true);

-- ACCESSORIES
INSERT INTO products (sku, name, category, brand, capacity_wh, output_watts, price_usd, price_includes_cuba_shipping, in_stock) VALUES
('PECRON-TROLLEY', 'PECRON Trolley', 'accessory', 'PECRON', NULL, NULL, 134.00, true, true);
